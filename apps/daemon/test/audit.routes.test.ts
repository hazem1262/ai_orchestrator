import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSession } from './factories.ts';
import { createFakeLive } from './fake-live.ts';
import { makeTempHomes, type TempHomes } from './homes.ts';
import { createP3Harness, P3_BASE, type P3Harness } from './p3-harness.ts';

let t: P3Harness;
let homes: TempHomes;

// Deviation from plan: the shipped `s-basic` fixture's cwd (/Users/test/Wakecap) does not exist, so
// resume returns 422 cwd_missing. Point the copied transcript at a real temp dir before indexing.
beforeEach(async () => {
  homes = makeTempHomes();
  const cwd = join(homes.root, 'work', 'Wakecap');
  mkdirSync(cwd, { recursive: true });
  const file = join(homes.claudeHome, 'projects', '-Users-test-Wakecap', 's-basic.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8').replaceAll('/Users/test/Wakecap', cwd));
  t = await createP3Harness({ homes });
});
afterEach(async () => {
  await t.cleanup();
  homes.cleanup();
});

const send = (method: 'POST' | 'DELETE', path: string, body: unknown) => t.request(path, { method, body });
const entries = (action: string) => t.ctx.audit?.list({ action }) ?? [];

async function resumeBasic(fork = false): Promise<string> {
  const res = await send('POST', '/api/sessions/claude/s-basic/resume', { mode: 'embedded', fork });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ptyId: string };
  return body.ptyId;
}

describe('write paths are audited', () => {
  it('session.resume records target, params and the new ptyId', async () => {
    const ptyId = await resumeBasic();
    const [e] = entries('session.resume');
    expect(e).toMatchObject({
      actor: 'user',
      target: 'claude:s-basic',
      result: 'ok',
      error: null,
      params: { mode: 'embedded', fork: false, status: 200, ptyId },
    });
    expect(entries('session.fork')).toHaveLength(0);
  });

  it('session.fork is a separate action', async () => {
    await resumeBasic(true);
    expect(entries('session.fork')).toHaveLength(1);
    expect(entries('session.resume')).toHaveLength(0);
  });

  it('session.launch records the cwd as target', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orc-launch-'));
    const res = await send('POST', '/api/sessions/launch', {
      source: 'claude',
      projectId: null,
      cwd,
      prompt: 'hello',
    });
    const [e] = entries('session.launch');
    expect(e?.target).toBe(cwd);
    expect(e?.result).toBe(res.status < 400 ? 'ok' : 'error');
    expect(e?.params.prompt).toBe('hello');
  });

  it('session.kill: unconfirmed requests are not recorded, confirmed ones are', async () => {
    // Deviation from plan: `s-basic` is not live in the fixtures (kill → 404 not_live), so mark it live.
    t.ctx.live = createFakeLive([
      makeSession({
        id: 's-basic',
        source: 'claude',
        live: {
          pid: 4242,
          status: 'busy',
          waitingFor: null,
          since: '',
          ownership: 'observed',
          ptyId: null,
          stage: null,
          currentTool: null,
          backgroundJobs: 0,
          runningSubagents: 0,
          contextFill: null,
        },
      }),
    ]);
    const unconfirmed = await send('POST', '/api/sessions/claude/s-basic/kill', {});
    expect(unconfirmed.status).toBe(409);
    expect(entries('session.kill')).toHaveLength(0);
    const confirmed = await send('POST', '/api/sessions/claude/s-basic/kill', { confirm: true });
    const [e] = entries('session.kill');
    expect(e?.target).toBe('claude:s-basic');
    expect(e?.result).toBe(confirmed.status < 400 ? 'ok' : confirmed.status === 403 ? 'denied' : 'error');
    expect(e?.params).not.toHaveProperty('confirm');
  });

  it('DELETE /api/pty/:id is a session.kill linked to the session', async () => {
    const ptyId = await resumeBasic();
    const res = await send('DELETE', `/api/pty/${ptyId}`, { confirm: true });
    expect(res.status).toBeLessThan(400);
    const killed = t.ctx.audit?.list({ sessionPk: 'claude:s-basic', action: 'session.kill' }) ?? [];
    expect(killed).toHaveLength(1);
    expect(killed[0]?.target).toBe(`pty:${ptyId}`);
  });

  it('archive.restore is recorded (not archived → error entry)', async () => {
    const res = await send('POST', '/api/archive/restore', {
      source: 'claude',
      id: 's-basic',
      confirm: true,
    });
    const [e] = entries('archive.restore');
    expect(e?.target).toBe('claude:s-basic');
    expect(e?.result).toBe(res.status < 400 ? 'ok' : 'error');
  });

  it('pty.input is recorded for owned sessions', async () => {
    const ptyId = await resumeBasic();
    t.ctx.pty.write(ptyId, 'yes\r');
    expect(entries('pty.input')[0]).toMatchObject({
      target: 'claude:s-basic',
      params: { text: 'yes', via: 'keys' },
    });
  });
});

describe('GET /api/audit', () => {
  it('filters by session and validates the query', async () => {
    await resumeBasic();
    const ok = await t.request('/api/audit?sessionPk=claude%3As-basic&limit=10');
    expect(ok.status).toBe(200);
    const items = (await ok.json()) as Array<{ action: string }>;
    expect(items.map((i) => i.action)).toEqual(['session.resume']);
    expect((await t.request('/api/audit?actor=hacker')).status).toBe(400);
    expect((await t.app.request(`${P3_BASE}/api/audit`)).status).toBe(401);
  });
});
