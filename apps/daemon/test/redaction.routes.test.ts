import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveEvent } from '@orc/api-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactSnippet, redactValue } from '../src/http/redact-out.ts';
import { toWireEvent } from '../src/http/ws-redact.ts';
import { createInboxEngine, type InboxEngineRuntime } from '../src/inbox/engine.ts';
import { makeTempHomes, type TempHomes } from './homes.ts';
import { createP3Harness, type P3Harness } from './p3-harness.ts';

const SECRET = 'hunter2';
// Built at runtime so no token-shaped literal sits in the source.
const PARTIAL_GH = ['ghp', 'abc12'].join('_');
let t: P3Harness;
let homes: TempHomes;
let inbox: InboxEngineRuntime;

// Deviation from plan (setup only): the shipped `s-basic` fixture's cwd (/Users/test/Wakecap) does
// not exist, so resume returns 422 cwd_missing. Point the copied transcript at a real temp dir
// before indexing, as `audit.routes.test.ts` does.
beforeAll(async () => {
  homes = makeTempHomes();
  const cwd = join(homes.root, 'work', 'Wakecap');
  mkdirSync(cwd, { recursive: true });
  const file = join(homes.claudeHome, 'projects', '-Users-test-Wakecap', 's-basic.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('/Users/test/Wakecap', cwd));
  t = await createP3Harness({ homes });
  // Deviation from plan (setup only): the P3 harness does not initialise `ctx.inbox`, so
  // `GET /api/inbox` answered 500 "inbox engine not initialised". Wire the engine the way
  // `routes/inbox.test.ts` does, and seed one item carrying the secret so the check has teeth.
  inbox = createInboxEngine(t.ctx);
  t.ctx.inbox = inbox;
  inbox.upsert({
    kind: 'waiting',
    scope: { session: 'claude:s-drift' },
    projectId: 'wakecap',
    reason: `PGPASSWORD=${SECRET} psql`,
    payload: { env: { PGPASSWORD: SECRET } },
  });
});
afterAll(async () => {
  inbox.stop();
  await t.cleanup();
  homes.cleanup();
});

const getText = async (path: string) => {
  const res = await t.request(path);
  expect(res.status).toBeLessThan(500);
  return res.text();
};

const PATHS = [
  '/api/sessions',
  '/api/sessions?q=psql',
  '/api/sessions?q=PGPASSWORD',
  '/api/sessions/claude/s-drift',
  '/api/sessions/claude/s-drift/events?limit=500',
  '/api/sessions/claude/s-drift/agents',
  '/api/sessions/claude/s-drift/stats',
  '/api/sessions/claude/s-drift/deliverables',
  '/api/sessions/claude/s-drift/files',
  '/api/sessions/claude/s-drift/usage-series',
  '/api/sessions/claude/s-drift/safety',
  '/api/sessions/claude/s-drift/raw',
  '/api/sessions/claude/s-drift/links',
  '/api/live',
  '/api/inbox',
  '/api/audit',
];

describe('no raw secret leaves the daemon', () => {
  it.each(PATHS)('%s', async (path) => {
    expect(await getText(path)).not.toContain(SECRET);
  });

  it('events carry the redaction marker instead', async () => {
    expect(await getText('/api/sessions/claude/s-drift/events?limit=500')).toContain('«redacted:secret»');
  });

  it('search snippets are stable under redactSnippet, which also masks cut-off tokens', async () => {
    const body = JSON.parse(await getText('/api/sessions?q=psql')) as {
      items: Array<{ snippet: string | null }>;
    };
    for (const i of body.items) if (i.snippet !== null) expect(i.snippet).toBe(redactSnippet(i.snippet));
    expect(redactSnippet(`…export GH=${PARTIAL_GH}`)).toBe('…export GH=«redacted:partial»');
  });

  it('redactValue masks sensitive keys', () => {
    expect(redactValue({ env: { PGPASSWORD: SECRET } })).toEqual({
      env: { PGPASSWORD: '«redacted:secret»' },
    });
  });

  it('audit params for PTY input are redacted', async () => {
    const res = await t.request('/api/sessions/claude/s-basic/resume', {
      method: 'POST',
      body: { mode: 'embedded' },
    });
    const { ptyId } = (await res.json()) as { ptyId: string };
    t.ctx.pty.write(ptyId, `export PGPASSWORD=${SECRET}\r`);
    const audit = await getText('/api/audit?action=pty.input');
    expect(audit).toContain('«redacted:secret»');
    expect(audit).not.toContain(SECRET);
  });
});

describe('toWireEvent', () => {
  it('redacts session, inbox and audit payloads and passes others through', () => {
    const base = t.ctx.sessions.get('claude', 's-drift');
    if (!base) throw new Error('fixture s-drift missing');
    const session = { ...base, lastPrompt: `PGPASSWORD=${SECRET} psql` };
    expect(JSON.stringify(toWireEvent({ type: 'session.updated', session }))).not.toContain(SECRET);
    const audit = toWireEvent({
      type: 'audit.recorded',
      entry: {
        id: 'a',
        ts: 't',
        actor: 'user',
        actorDetail: null,
        action: 'pty.input',
        target: null,
        params: { text: `password=${SECRET}` },
        result: 'ok',
        error: null,
      },
    });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    const hello: LiveEvent = { type: 'hello', serverTime: '2026-09-17T00:00:00.000Z' };
    expect(toWireEvent(hello)).toBe(hello);
  });
});
