import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createDaemon, type Daemon } from '../src/main.ts';
import { createTestContext } from './helpers.ts';
import { FAKE_CLAUDE, makeTempHomes, type TempHomes, writeClaudeSession } from './homes.ts';

let homes: TempHomes;
let daemon: Daemon;
let server: { port: number; close(): Promise<void> } | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  homes?.cleanup();
});

async function boot(): Promise<number> {
  homes = makeTempHomes();
  // writes the fake-claude config into ORC_HOME, then disposes the throwaway context
  createTestContext({ homes }).dispose();
  writeClaudeSession(homes, { sessionId: 's-ws', cwd: join(homes.root, 'work', 'ws'), prompt: 'ws session' });
  daemon = await createDaemon({
    paths: homes.paths,
    log: pino({ level: 'silent' }),
    launchExternal: async () => undefined,
    webDist: null,
  });
  const running = await daemon.start({ port: 0, watch: false });
  server = running;
  return running.port;
}

function open(
  port: number,
  path: string,
  origin: string | undefined,
): Promise<{ ws: WebSocket; frames: Array<{ binary: boolean; text: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
    const frames: Array<{ binary: boolean; text: string }> = [];
    ws.on('message', (data, isBinary) => {
      frames.push({ binary: isBinary, text: Buffer.isBuffer(data) ? data.toString('utf8') : String(data) });
    });
    ws.once('open', () => resolve({ ws, frames }));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('daemon server', () => {
  it('boots, indexes, resumes and streams a PTY over WebSocket with replay', async () => {
    const port = await boot();
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'x-orc-token': daemon.token, 'content-type': 'application/json' };
    await waitFor(() => daemon.ctx.sessions.get('claude', 's-ws') !== null);

    const health = await fetch(`${base}/api/health`, { headers });
    expect(health.status).toBe(200);

    const res = await fetch(`${base}/api/sessions/claude/s-ws/resume`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ mode: 'embedded' }),
    });
    const { ptyId } = (await res.json()) as { ptyId: string };
    const origin = `http://127.0.0.1:${port}`;

    const first = await open(port, `/pty/${ptyId}?token=${daemon.token}`, origin);
    await waitFor(() =>
      first.frames
        .map((f) => f.text)
        .join('')
        .includes('fake-claude'),
    );
    expect(first.frames[0]?.binary).toBe(true);
    first.ws.send(JSON.stringify({ t: 'in', d: 'ping-from-ws\r' }));
    first.ws.send('not json');
    first.ws.send(JSON.stringify({ t: 'resize', cols: 90, rows: 20 }));
    await waitFor(() =>
      first.frames
        .map((f) => f.text)
        .join('')
        .includes('ping-from-ws'),
    );
    await waitFor(() => daemon.ctx.pty.get(ptyId)?.cols === 90);
    first.ws.close();

    const second = await open(port, `/pty/${ptyId}?token=${daemon.token}`, origin);
    await waitFor(() => second.frames.length > 0);
    expect(second.frames[0]?.text).toContain('fake-claude');
    expect(second.frames[0]?.text).toContain('ping-from-ws');

    const closed = new Promise<number>((r) => second.ws.once('close', (code) => r(code)));
    daemon.ctx.pty.kill(ptyId);
    expect(await closed).toBe(1000);
    expect(second.frames.at(-1)).toEqual({
      binary: false,
      text: expect.stringMatching(/^\{"t":"exit","code":/),
    });
  });

  it('rejects bad tokens, origins, unknown PTYs and other paths', async () => {
    const port = await boot();
    const origin = `http://127.0.0.1:${port}`;
    await expect(open(port, '/pty/nope?token=wrong', origin)).rejects.toThrow('status 401');
    await expect(open(port, `/pty/nope?token=${daemon.token}`, 'http://evil.test')).rejects.toThrow(
      'status 403',
    );
    await expect(open(port, `/pty/nope?token=${daemon.token}`, undefined)).rejects.toThrow('status 403');
    await expect(open(port, `/pty/nope?token=${daemon.token}`, origin)).rejects.toThrow('status 404');
    await expect(open(port, `/other?token=${daemon.token}`, origin)).rejects.toThrow();
  });

  it('serves bootstrap.js to local same-origin requests', async () => {
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/bootstrap.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(daemon.token);
  });

  it('survives an oversized client frame without taking down the daemon or other sessions', async () => {
    const port = await boot();
    const base = `http://127.0.0.1:${port}`;
    const origin = `http://127.0.0.1:${port}`;
    const victimPty = daemon.ctx.pty.spawn({ command: FAKE_CLAUDE, args: [], cwd: homes.root });
    const otherPty = daemon.ctx.pty.spawn({ command: FAKE_CLAUDE, args: [], cwd: homes.root });

    const victim = await open(port, `/pty/${victimPty.id}?token=${daemon.token}`, origin);
    await waitFor(() => victim.frames.length > 0);

    const victimClosed = new Promise<void>((resolve) => victim.ws.once('close', () => resolve()));
    // 2 MiB text frame, well over the server's `maxPayload: 1 << 20` (1 MiB) — the ws Receiver
    // rejects this at the transport layer before any 'message' handler runs.
    victim.ws.send('x'.repeat(2 * 1024 * 1024));
    await victimClosed;
    expect(victim.ws.readyState).toBe(WebSocket.CLOSED);

    // The daemon process (and its HTTP server) must still be alive and serving requests.
    const health = await fetch(`${base}/api/health`, { headers: { 'x-orc-token': daemon.token } });
    expect(health.status).toBe(200);

    // A second, unrelated PTY socket must still be fully usable.
    const other = await open(port, `/pty/${otherPty.id}?token=${daemon.token}`, origin);
    await waitFor(() =>
      other.frames
        .map((f) => f.text)
        .join('')
        .includes('fake-claude'),
    );
    other.ws.send(JSON.stringify({ t: 'in', d: 'still-alive\r' }));
    await waitFor(() =>
      other.frames
        .map((f) => f.text)
        .join('')
        .includes('still-alive'),
    );
    other.ws.close();
  });
});
