import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxItem, Session } from '@orc/core';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.ts';
import type { DaemonContext } from '../src/context.ts';
import { createApp } from '../src/http/app.ts';
import { parseLstart } from '../src/live/liveness.ts';
import { createDaemon, type Daemon } from '../src/main.ts';
import { createTestContext } from './helpers.ts';
import { FAKE_BIN_DIR, makeTempHomes, type TempHomes } from './homes.ts';
import { CENSUS } from './route-census.ts';

/**
 * Phase 2 wired into the real daemon: `createDaemon` + `start`, a real HTTP server, a real `/ws`
 * upgrade, and the fake `claude` in `test/bin` (never the real CLI). The fake writes its registry
 * entry and transcript only under `$CLAUDE_HOME`, which points at this test's temp home.
 */
const saved = {
  PATH: process.env.PATH,
  ORC_NOTIFY: process.env.ORC_NOTIFY,
  CLAUDE_HOME: process.env.CLAUDE_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
};
const restoreEnv = (key: keyof typeof saved): void => {
  const v = saved[key];
  if (v === undefined) delete process.env[key];
  else process.env[key] = v;
};

let homes: TempHomes | undefined;
let daemon: Daemon;
let running: { port: number; close(): Promise<void> } | undefined;
let base: string;
let token: string;
let logLines: Array<Record<string, unknown>>;
const cwds: string[] = [];
const sockets: WebSocket[] = [];

beforeAll(() => {
  process.env.PATH = `${FAKE_BIN_DIR}:${saved.PATH ?? ''}`;
  process.env.ORC_NOTIFY = 'off';
});
afterAll(() => {
  restoreEnv('PATH');
  restoreEnv('ORC_NOTIFY');
});
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  if (daemon)
    for (const p of daemon.ctx.pty.list()) if (p.exitedAt === null) daemon.ctx.pty.kill(p.id, 'SIGKILL');
  await running?.close();
  running = undefined;
  homes?.cleanup();
  homes = undefined;
  for (const c of cwds.splice(0)) rmSync(c, { recursive: true, force: true });
  restoreEnv('CLAUDE_HOME');
  restoreEnv('CODEX_HOME');
});

/** Boots the real daemon on a temp home. `before` runs after the homes exist and before boot. */
async function boot(before?: (h: TempHomes) => void): Promise<void> {
  homes = makeTempHomes();
  // writes a config whose resumeProfile points at the fake claude, then disposes the throwaway context
  createTestContext({ homes }).dispose();
  process.env.CLAUDE_HOME = homes.claudeHome;
  process.env.CODEX_HOME = homes.codexHome;
  before?.(homes);
  logLines = [];
  const log = pino({ level: 'debug' }, { write: (s: string) => void logLines.push(JSON.parse(s)) });
  daemon = await createDaemon({
    paths: homes.paths,
    log,
    launchExternal: async () => undefined,
    webDist: null,
  });
  running = await daemon.start({ port: 0, watch: false });
  base = `http://127.0.0.1:${running.port}`;
  token = daemon.token;
}

const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'x-orc-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
};

interface Opened {
  ws: WebSocket;
  messages: Array<{ type: string; item?: InboxItem; snapshot?: unknown }>;
  frames: string[];
  closed: Promise<number>;
}

function openWs(path: string, o: { token?: string | null; origin?: string } = {}): Promise<Opened> {
  const port = running?.port;
  const tok = o.token === undefined ? token : o.token;
  const sep = path.includes('?') ? '&' : '?';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}${tok ? `${sep}token=${tok}` : ''}`, {
      headers: { origin: o.origin ?? `http://127.0.0.1:${port}` },
    });
    sockets.push(ws);
    const messages: Opened['messages'] = [];
    const frames: string[] = [];
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    ws.on('message', (d, isBinary) => {
      const text = Buffer.isBuffer(d) ? d.toString('utf8') : String(d);
      frames.push(text);
      if (!isBinary) {
        try {
          messages.push(JSON.parse(text));
        } catch {
          // not JSON
        }
      }
    });
    ws.once('open', () => resolve({ ws, messages, frames, closed }));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

const tmpCwd = (): string => {
  const c = mkdtempSync(join(tmpdir(), 'orc-e2e-'));
  cwds.push(c);
  return c;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad2 = (n: number): string => String(n).padStart(2, '0');
/** `procStart` as Claude Code writes it: the `ps lstart` calendar grammar, rendered in UTC. */
function utcProcStart(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${pad2(
    d.getUTCHours(),
  )}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}
/** This test process's start instant, read the way the liveness checker reads it. */
function ownStartMs(): number {
  const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  }).trim();
  const ms = parseLstart(lstart);
  if (ms === null) throw new Error(`cannot parse ps lstart ${JSON.stringify(lstart)}`);
  return ms;
}
/** A registry entry in `<claudeHome>/sessions/<pid>.json` for this (alive) test process. */
function writeOwnRegistry(h: TempHomes, o: { sessionId: string; status: string; procStart: string }): void {
  const dir = join(h.claudeHome, 'sessions');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  writeFileSync(
    join(dir, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      procStart: o.procStart,
      sessionId: o.sessionId,
      cwd: h.root,
      startedAt: now - 60_000,
      version: 'fake',
      kind: 'interactive',
      entrypoint: 'cli',
      name: 'already waiting',
      status: o.status,
      waitingFor: o.status === 'waiting' ? 'input needed' : null,
      statusUpdatedAt: now - 30_000,
      updatedAt: now - 30_000,
    }),
  );
}

describe('phase 2 daemon end to end (fake claude)', () => {
  it('rejects unauthenticated API and WS calls', async () => {
    await boot();
    expect((await fetch(`${base}/api/live`)).status).toBe(401);
    await expect(openWs('/ws', { token: null })).rejects.toThrow(/401/);
  });

  it('launch → waiting inbox item within 2 s → kill → auto-resolved', { timeout: 30_000 }, async () => {
    await boot();
    const { messages } = await openWs('/ws');
    await expect.poll(() => messages[0]?.type).toBe('hello');
    const launched = await api<{ ptyId: string; sessionId: string }>('POST', '/api/sessions/launch', {
      source: 'claude',
      projectId: null,
      cwd: tmpCwd(),
      prompt: 'please wait for me',
    });
    expect(launched.status).toBe(200);
    const pk = `claude:${launched.json.sessionId}`;
    const pid = Number(launched.json.sessionId.replace('fake-', ''));

    await expect
      .poll(async () => (await api<InboxItem[]>('GET', '/api/inbox?state=open&kind=waiting')).json.length, {
        timeout: 5000,
        interval: 100,
      })
      .toBe(1);
    const reg = JSON.parse(
      readFileSync(join(homes?.claudeHome ?? '', 'sessions', `${pid}.json`), 'utf8'),
    ) as {
      statusUpdatedAt: number;
    };
    const [item] = (await api<InboxItem[]>('GET', '/api/inbox?state=open&kind=waiting')).json;
    // registry timestamps have 1 s resolution in the fake, so allow 1 s of slack on top of the 2 s budget
    expect(Date.parse(item?.createdAt ?? '') - reg.statusUpdatedAt).toBeLessThan(3000);
    expect(item?.payload).toMatchObject({ source: 'claude', id: launched.json.sessionId });
    await expect
      .poll(() => messages.some((m) => m.type === 'inbox.upserted' && m.item?.kind === 'waiting'))
      .toBe(true);

    const live = await api<Session[]>('GET', '/api/live');
    expect(live.json.find((s) => `${s.source}:${s.id}` === pk)?.live).toMatchObject({
      status: 'waiting',
      ownership: 'owned',
    });

    // The phase 1 PTY socket still streams on the same server once `/ws` is dispatched beside it.
    const pty = await openWs(`/pty/${launched.json.ptyId}`);
    await expect.poll(() => pty.frames.join(''), { timeout: 5000 }).toContain('fake-claude');

    expect((await api('POST', `/api/sessions/claude/${launched.json.sessionId}/kill`, {})).status).toBe(409);
    expect(
      (await api('POST', `/api/sessions/claude/${launched.json.sessionId}/kill`, { confirm: true })).json,
    ).toEqual({ killed: 'pty' });
    await expect
      .poll(
        async () => (await api<InboxItem[]>('GET', '/api/inbox?state=auto_resolved')).json.map((i) => i.kind),
        {
          timeout: 5000,
          interval: 100,
        },
      )
      .toContain('waiting');
  });

  it('review and tests_red items from a failing run', { timeout: 30_000 }, async () => {
    await boot();
    const launched = await api<{ sessionId: string }>('POST', '/api/sessions/launch', {
      source: 'claude',
      projectId: null,
      cwd: tmpCwd(),
      prompt: 'fix it and fail',
    });
    expect(launched.status).toBe(200);
    await expect
      .poll(
        async () =>
          (await api<InboxItem[]>('GET', '/api/inbox?state=open')).json
            .filter((i) => (i.payload as { id?: string } | null)?.id === launched.json.sessionId)
            .map((i) => i.kind)
            .sort(),
        { timeout: 8000, interval: 100 },
      )
      .toEqual(['review', 'tests_red']);
  });

  it('serves the 10 built-in templates, notification prefs and archive status', async () => {
    await boot();
    const templates = await api<unknown[]>('GET', '/api/templates');
    expect(templates.status).toBe(200);
    expect(templates.json).toHaveLength(10);
    expect((await api<Record<string, unknown>>('GET', '/api/config/notifications')).json).toHaveProperty(
      'waiting',
    );
    const synced = await api<{ copied: number }>('POST', '/api/archive/sync', {});
    expect(synced.status).toBe(200);
    const status = await api<{ files: number }>('GET', '/api/archive/status');
    expect(status.status).toBe(200);
    expect(status.json.files).toBeGreaterThanOrEqual(9);
  });
});

describe('phase 2 services on the daemon context', () => {
  it('sets every phase 2 service on ctx once the daemon has started', async () => {
    await boot();
    const ctx: DaemonContext = daemon.ctx;
    expect(ctx.live).toBeDefined();
    expect(ctx.inbox).toBeDefined();
    expect(ctx.notifier).toBeDefined();
    expect(ctx.templates).toBeDefined();
    expect(ctx.templates?.list()).toHaveLength(10);
    expect(ctx.launcher).toBeDefined();
    expect(ctx.archive).toBeDefined();
    expect(typeof ctx.updateConfig).toBe('function');
  });

  it('starts the archive on boot (first sync runs with no request) and stops it on close', async () => {
    await boot();
    await expect
      .poll(async () => (await api<{ files: number }>('GET', '/api/archive/status')).json.files, {
        timeout: 5000,
        interval: 100,
      })
      .toBeGreaterThanOrEqual(9);
    const archive = daemon.ctx.archive;
    expect(archive).toBeDefined();
    if (!archive) return;
    const stop = vi.spyOn(archive, 'stop');
    await running?.close();
    running = undefined;
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('persists PUT /api/config/notifications through ctx.updateConfig', async () => {
    await boot();
    const res = await api<Record<string, { enabled: boolean }>>('PUT', '/api/config/notifications', {
      waiting: { enabled: false, channels: [] },
    });
    expect(res.status).toBe(200);
    expect(res.json.waiting?.enabled).toBe(false);
    expect(loadConfig(homes?.paths ?? daemon.ctx.paths).notifications?.waiting?.enabled).toBe(false);
  });

  it('upserts an inbox item on boot for a session that was already waiting', {
    timeout: 15_000,
  }, async () => {
    // Real `procStart` for this process, so the liveness guard accepts it as alive.
    const procStart = utcProcStart(ownStartMs());
    await boot((h) =>
      writeOwnRegistry(h, { sessionId: 'pre-existing-waiting', status: 'waiting', procStart }),
    );
    await expect
      .poll(
        async () =>
          [(await api<InboxItem[]>('GET', '/api/inbox?state=open&kind=waiting')).json]
            .flat()
            .map((i) => (i.payload as { id?: string } | null)?.id),
        { timeout: 8000, interval: 100 },
      )
      .toContain('pre-existing-waiting');
  });

  it('routes a suspected procStart format change to ctx.log.warn', { timeout: 15_000 }, async () => {
    // Off by exactly one hour: the fingerprint of a timezone/format change, not a recycled pid.
    const procStart = utcProcStart(ownStartMs() + 3_600_000);
    await boot((h) => writeOwnRegistry(h, { sessionId: 'skewed', status: 'busy', procStart }));
    await expect
      .poll(() => logLines.some((l) => l.level === 40 && JSON.stringify(l).includes(procStart)), {
        timeout: 8000,
        interval: 100,
      })
      .toBe(true);
  });
});

describe('the /ws upgrade beside the PTY socket', () => {
  it('accepts an authenticated same-origin client with a hello frame', async () => {
    await boot();
    const { messages } = await openWs('/ws');
    await expect.poll(() => messages[0]?.type).toBe('hello');
  });

  it('rejects a bad origin with 403', async () => {
    await boot();
    await expect(openWs('/ws', { origin: 'http://evil.example' })).rejects.toThrow(/403/);
  });

  it('closes a client that sends a frame over 1 MiB with 1009 and keeps serving', async () => {
    await boot();
    const big = await openWs('/ws');
    big.ws.send(Buffer.alloc((1 << 20) + 1, 0x61));
    expect(await big.closed).toBe(1009);
    const next = await openWs('/ws');
    await expect.poll(() => next.messages[0]?.type).toBe('hello');
    expect((await api('GET', '/api/health')).status).toBe(200);
  });

  it('keeps the PTY socket guards: 401 without a token, 404 for an unknown pty', async () => {
    await boot();
    await expect(openWs('/pty/nope', { token: null })).rejects.toThrow(/401/);
    await expect(openWs('/pty/nope')).rejects.toThrow(/404/);
  });

  it('delivers usage.updated with numeric token counts intact', async () => {
    // `usage.updated` is the one wire shape whose subject is token counts. Key-aware redaction
    // replaces STRING values under `*token*` keys only, so numeric counts must survive the hub.
    await boot();
    const { messages } = await openWs('/ws');
    await expect.poll(() => messages[0]?.type).toBe('hello');
    const snapshot = {
      byModel: [{ model: 'fake-model', inputTokens: 1234, token_count: 56, maxTokens: 200000 }],
    };
    daemon.ctx.bus.emit({ type: 'usage.updated', snapshot });
    await expect.poll(() => messages.find((m) => m.type === 'usage.updated')?.snapshot).toEqual(snapshot);
  });
});

describe('phase 2 routes in the census', () => {
  const PHASE2_ROUTES: Record<string, string | null | undefined> = {
    'GET /api/live': 'redactSession',
    'POST /api/hooks': undefined,
    'GET /api/inbox': 'redactInboxItem',
    'POST /api/inbox/:id/:action{done|snooze|reopen}': 'redactInboxItem',
    'GET /api/templates': undefined,
    'POST /api/sessions/launch': undefined,
    'POST /api/sessions/:source/:id/kill': undefined,
    'POST /api/sessions/:source/:id/open-in': undefined,
    'GET /api/config/notifications': undefined,
    'PUT /api/config/notifications': undefined,
  };
  const app = createApp({ ctx: {} as DaemonContext, token: 't', port: () => 4317, env: {}, webDist: null });
  const order = app.routes.map((r) => `${r.method} ${r.path}`);

  it.each(Object.keys(PHASE2_ROUTES))('registers %s above the /api/* catch-all', (route) => {
    const at = order.indexOf(route);
    expect(at, `${route} is not registered`).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(order.lastIndexOf('ALL /api/*'));
  });

  it.each(Object.entries(PHASE2_ROUTES))('declares %s in CENSUS', (route, guard) => {
    expect(CENSUS[route], `${route} has no CENSUS row`).toBeDefined();
    if (guard !== undefined) expect(CENSUS[route]?.guardedBy).toBe(guard);
  });
});
