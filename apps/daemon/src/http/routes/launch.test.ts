import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveState, Session } from '@orc/core';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLive } from '../../../test/fake-live.ts';
import { createFakePty } from '../../../test/fake-pty.ts';
import { createTestContext, type TestContext, useTempHomes } from '../../../test/helpers.ts';
import type { ExecFn } from '../../live/liveness.ts';
import { stubSession } from '../../live/stub-session.ts';
import { createLaunchService } from '../../services/launch.ts';
import { openIn, openInCommand } from '../../services/open-in.ts';
import { projectConfigFor } from '../../services/projects.ts';
import { createTemplateRegistry } from '../../services/templates.ts';
import { registerLaunchRoutes } from './launch.ts';

/**
 * Nothing here starts a real process or opens a real app: PTYs come from `createFakePty`, the
 * observed-session kill goes through a `killPid` spy, and open-in goes through an `exec` spy.
 */
const homes = useTempHomes();
let ctx: TestContext;
let app: Hono;
let pty: ReturnType<typeof createFakePty>;
let live: ReturnType<typeof createFakeLive>;
let root: string;
let cwd: string;
let cap: number | undefined;
const SECRET = 'hunter2';
const exec = vi.fn<ExecFn>(async () => ({ stdout: '', exitCode: 0 }));
const update = vi.fn();
const killPid = vi.fn();
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const postRaw = (path: string, body: string) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; details?: Record<string, unknown> } }).error;

const liveState = (over: Partial<LiveState> = {}): LiveState => ({
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
  ...over,
});
const session = (id: string, name: string, dir: string, l: Partial<LiveState> = {}): Session => ({
  ...stubSession({ source: 'claude', id, cwd: dir, startedAt: '', projectId: 'wakecap', name }),
  live: liveState(l),
});

beforeEach(() => {
  pty = createFakePty();
  ctx = createTestContext({ homes, pty });
  root = mkdtempSync(join(tmpdir(), 'orc-lr-'));
  cwd = join(root, 'wakecap');
  mkdirSync(cwd);
  live = createFakeLive([session('s-live', 'SLA weekends', cwd)]);
  ctx.live = live;
  ctx.templates = createTemplateRegistry();
  cap = undefined;
  const real = ctx.projects;
  update.mockReset();
  update.mockImplementation((id: string, patch: object) => ({
    ...projectConfigFor({ id, name: id, pathPrefix: cwd }),
    ...patch,
  }));
  ctx.projects = {
    ...real,
    resolve: (c: string) => (c.startsWith(root) ? 'wakecap' : null),
    get: (id: string) => {
      const p = projectConfigFor({ id, name: id, pathPrefix: cwd });
      return cap === undefined ? p : { ...p, maxConcurrentOwned: cap };
    },
    update,
  };
  const base = ctx.config();
  ctx.config = () => ({
    ...base,
    resumeProfile: { ...base.resumeProfile, claudeCommand: 'claude', codexCommand: 'codex' },
  });
  killPid.mockReset();
  ctx.launcher = createLaunchService(ctx, {
    discoverTimeoutMs: 10,
    killPid,
    liveness: { isAlive: async () => true },
  });
  exec.mockClear();
  app = new Hono();
  registerLaunchRoutes(app, ctx, { exec });
});

afterEach(() => {
  ctx.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('POST /api/sessions/launch', () => {
  it('launches and maps errors', async () => {
    const ok = await post('/api/sessions/launch', {
      source: 'claude',
      projectId: 'wakecap',
      cwd,
      prompt: 'hi',
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ptyId: 'pty-1', sessionId: null });
    expect((await post('/api/sessions/launch', { source: 'agnc', cwd })).status).toBe(400);
    const nyi = await post('/api/sessions/launch', {
      source: 'claude',
      projectId: null,
      cwd,
      planApproval: true,
    });
    expect(nyi.status).toBe(501);
    expect((await errorOf(nyi)).code).toBe('not_implemented');
  });

  it.each([
    [{ planApproval: true }, 'planApproval'],
    [{ worktree: { repo: '/r', base: 'main', type: 'feat', slug: 'x' } }, 'worktree'],
    [{ compare: [{ source: 'codex' }] }, 'compare'],
  ])('answers 501 not_implemented with details.field for %j', async (over, field) => {
    const res = await post('/api/sessions/launch', { source: 'claude', projectId: 'wakecap', cwd, ...over });
    expect(res.status).toBe(501);
    expect(await errorOf(res)).toMatchObject({ code: 'not_implemented', details: { field } });
    expect(pty.spawned).toHaveLength(0);
  });

  it('answers 429 concurrency_limit with projectId, max and running', async () => {
    cap = 1;
    const body = { source: 'claude', projectId: 'wakecap', cwd, prompt: 'one' };
    expect((await post('/api/sessions/launch', body)).status).toBe(200);
    const res = await post('/api/sessions/launch', { ...body, prompt: 'two' });
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toMatchObject({
      code: 'concurrency_limit',
      details: { projectId: 'wakecap', max: 1, running: 1 },
    });
    expect(pty.spawned).toHaveLength(1);
  });

  it('maps prompt and template errors to their own codes', async () => {
    const base = { source: 'claude', projectId: 'wakecap', cwd };
    const flag = await post('/api/sessions/launch', { ...base, prompt: '--help' });
    expect(flag.status).toBe(400);
    expect((await errorOf(flag)).code).toBe('validation_failed');

    const invalid = await post('/api/sessions/launch', {
      ...base,
      templateId: 'wf-investigate',
      ticket: 'SAF-1\u0007',
    });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).code).toBe('template_var_invalid');

    const missing = await post('/api/sessions/launch', { ...base, templateId: 'wf-review-pr' });
    expect(missing.status).toBe(400);
    expect(await errorOf(missing)).toMatchObject({
      code: 'template_var_missing',
      details: { missing: ['prUrl'] },
    });

    const unknown = await post('/api/sessions/launch', { ...base, templateId: 'nope' });
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe('template_not_found');

    const noDir = await post('/api/sessions/launch', { ...base, cwd: join(cwd, 'missing') });
    expect(noDir.status).toBe(400);
    expect((await errorOf(noDir)).code).toBe('cwd_not_found');

    expect(pty.spawned).toHaveLength(0);
  });

  it('rejects a body that is not JSON with validation_failed', async () => {
    const res = await postRaw('/api/sessions/launch', '{not json');
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('validation_failed');
  });

  it('answers 503 when no launcher is wired', async () => {
    ctx.launcher = undefined;
    const res = await post('/api/sessions/launch', { source: 'claude', projectId: 'wakecap', cwd });
    expect(res.status).toBe(503);
    expect(pty.spawned).toHaveLength(0);
  });
});

describe('POST /api/sessions/:source/:id/kill', () => {
  it('requires confirmation and then kills', async () => {
    const first = await post('/api/sessions/claude/s-live/kill', {});
    expect(first.status).toBe(409);
    const err = await errorOf(first);
    expect(err.code).toBe('confirmation_required');
    expect(err.details?.summary).toBe(`Stop "SLA weekends" (pid 4242) in ${cwd}?`);
    expect(killPid).not.toHaveBeenCalled();
    const declined = await post('/api/sessions/claude/s-live/kill', { confirm: false });
    expect(declined.status).toBe(409);
    expect(killPid).not.toHaveBeenCalled();
    const ok = await post('/api/sessions/claude/s-live/kill', { confirm: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ killed: 'pid' });
    expect(killPid).toHaveBeenCalledWith(4242);
    expect(pty.killed).toEqual([]);
    expect((await post('/api/sessions/claude/nope/kill', { confirm: true })).status).toBe(404);
    expect((await post('/api/sessions/cursor/x/kill', { confirm: true })).status).toBe(400);
  });

  it('kills an owned session through its PTY', async () => {
    const info = pty.spawn({ command: 'claude', args: [], cwd });
    live.sessions = [session('s-owned', 'mine', cwd, { ownership: 'owned', ptyId: info.id, pid: info.pid })];
    const res = await post('/api/sessions/claude/s-owned/kill', { confirm: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ killed: 'pty' });
    expect(pty.killed).toEqual([{ id: info.id, signal: 'SIGTERM' }]);
    expect(killPid).not.toHaveBeenCalled();
  });

  it('answers 404 not_live for an ended session, confirmed or not', async () => {
    live.sessions = [session('s-ended', 'done', cwd, { status: 'ended' })];
    for (const body of [{}, { confirm: true }]) {
      const res = await post('/api/sessions/claude/s-ended/kill', body);
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe('not_live');
    }
    expect(killPid).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/:source/:id/open-in', () => {
  it('opens the cwd and remembers the choice for the project', async () => {
    const res = await post('/api/sessions/claude/s-live/open-in', { app: 'vscode' });
    expect(res.status).toBe(200);
    expect(exec).toHaveBeenCalledWith('code', [cwd]);
    expect(update).toHaveBeenCalledWith('wakecap', { openIn: 'vscode' });
    await post('/api/sessions/claude/s-live/open-in', { app: 'finder', remember: false });
    expect(update).toHaveBeenCalledTimes(1);
    expect((await post('/api/sessions/claude/unknown/open-in', { app: 'finder' })).status).toBe(404);
  });

  it("uses the session's latest known cwd", async () => {
    const later = join(root, 'later');
    mkdirSync(later);
    live.sessions = [{ ...session('s-moved', 'moved', cwd), cwds: [cwd, later] }];
    const res = await post('/api/sessions/claude/s-moved/open-in', { app: 'vscode', remember: false });
    expect(res.status).toBe(200);
    expect(exec).toHaveBeenCalledWith('code', [later]);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects an unknown app or source and a missing directory without running anything', async () => {
    expect((await post('/api/sessions/claude/s-live/open-in', { app: 'emacs' })).status).toBe(400);
    expect((await post('/api/sessions/cursor/s-live/open-in', { app: 'vscode' })).status).toBe(400);
    live.sessions = [session('s-gone', 'gone', join(root, 'deleted-worktree'))];
    const gone = await post('/api/sessions/claude/s-gone/open-in', { app: 'vscode' });
    expect(gone.status).toBe(404);
    expect((await errorOf(gone)).code).toBe('cwd_not_found');
    expect(exec).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('openInCommand', () => {
  it.each([
    ['darwin', 'vscode', { command: 'code', args: ['/p'] }],
    ['darwin', 'terminal', { command: 'open', args: ['-a', 'Terminal', '/p'] }],
    ['darwin', 'finder', { command: 'open', args: ['/p'] }],
    ['linux', 'vscode', { command: 'code', args: ['/p'] }],
    ['linux', 'terminal', { command: 'x-terminal-emulator', args: ['--working-directory', '/p'] }],
    ['linux', 'finder', { command: 'xdg-open', args: ['/p'] }],
  ] as const)('%s %s', (platform, target, expected) => {
    expect(openInCommand(target, '/p', platform)).toEqual(expected);
  });
});

describe('openIn', () => {
  it('runs the command through the given exec and rejects on a non-zero exit', async () => {
    const run = vi.fn<ExecFn>(async () => ({ stdout: '', exitCode: 0 }));
    await openIn('vscode', '/p', run);
    expect(run).toHaveBeenCalledWith('code', ['/p']);
    const failing = vi.fn<ExecFn>(async () => ({ stdout: '', exitCode: 1 }));
    await expect(openIn('vscode', '/p', failing)).rejects.toThrow();
  });
});

describe('secret redaction on the way out', () => {
  const noSecret = async (res: Response, label: string) => {
    const text = await res.text();
    expect(text, label).not.toContain(SECRET);
    return text;
  };

  it('never echoes a secret from the prompt or cwd in a launch response or error body', async () => {
    const secretDir = join(root, `PGPASSWORD=${SECRET}`);
    mkdirSync(secretDir);
    const base = { source: 'claude', projectId: 'wakecap' };

    const ok = await post('/api/sessions/launch', {
      ...base,
      cwd: secretDir,
      prompt: `use PGPASSWORD=${SECRET}`,
    });
    expect(ok.status).toBe(200);
    await noSecret(ok, 'launch result');

    const missing = await post('/api/sessions/launch', {
      ...base,
      cwd: join(secretDir, 'missing'),
      prompt: 'x',
    });
    expect(missing.status).toBe(400);
    expect(await noSecret(missing, 'cwd_not_found')).toContain('cwd_not_found');

    const flag = await post('/api/sessions/launch', { ...base, cwd, prompt: `-PGPASSWORD=${SECRET}` });
    expect(flag.status).toBe(400);
    expect(await noSecret(flag, 'validation_failed prompt')).toContain('validation_failed');

    const invalid = await post('/api/sessions/launch', {
      ...base,
      cwd,
      templateId: 'wf-investigate',
      ticket: `PGPASSWORD=${SECRET}\u0007`,
    });
    expect(invalid.status).toBe(400);
    expect(await noSecret(invalid, 'template_var_invalid')).toContain('template_var_invalid');

    const badKey = await post('/api/sessions/launch', { ...base, cwd, [`PGPASSWORD=${SECRET}`]: 1 });
    expect(badKey.status).toBe(400);
    expect(await noSecret(badKey, 'unknown key')).toContain('validation_failed');

    const mismatch = await post('/api/sessions/launch', {
      ...base,
      projectId: `PGPASSWORD=${SECRET}`,
      cwd,
      prompt: 'x',
    });
    expect(mismatch.status).toBe(400);
    expect(await noSecret(mismatch, 'projectId mismatch')).toContain('validation_failed');

    cap = 1;
    const capped = await post('/api/sessions/launch', {
      ...base,
      cwd: secretDir,
      prompt: `again PGPASSWORD=${SECRET}`,
    });
    expect(capped.status).toBe(429);
    expect(await noSecret(capped, 'concurrency_limit')).toContain('concurrency_limit');
  });

  it('never echoes a secret from the session cwd or name in kill or open-in bodies', async () => {
    const secretDir = join(root, `PGPASSWORD=${SECRET}`);
    mkdirSync(secretDir);
    live.sessions = [
      session('s-secret', `token PGPASSWORD=${SECRET}`, secretDir),
      session('s-gone', 'gone', join(secretDir, 'deleted')),
    ];

    const confirm = await post('/api/sessions/claude/s-secret/kill', {});
    expect(confirm.status).toBe(409);
    expect(await noSecret(confirm, 'confirmation summary')).toContain('confirmation_required');

    const killed = await post('/api/sessions/claude/s-secret/kill', { confirm: true });
    expect(killed.status).toBe(200);
    await noSecret(killed, 'kill result');

    const opened = await post('/api/sessions/claude/s-secret/open-in', { app: 'finder', remember: false });
    expect(opened.status).toBe(200);
    await noSecret(opened, 'open-in result');

    const gone = await post('/api/sessions/claude/s-gone/open-in', { app: 'finder' });
    expect(gone.status).toBe(404);
    expect(await noSecret(gone, 'open-in cwd_not_found')).toContain('cwd_not_found');

    exec.mockImplementationOnce(async () => {
      throw new Error(`open failed for ${secretDir}`);
    });
    const failed = await post('/api/sessions/claude/s-secret/open-in', { app: 'finder', remember: true });
    expect(failed.status).toBe(500);
    const failedText = await noSecret(failed, 'open-in open_in_failed');
    expect(JSON.parse(failedText)).toMatchObject({ error: { code: 'open_in_failed' } });
    expect(update).not.toHaveBeenCalled();

    const notLive = await post(`/api/sessions/claude/PGPASSWORD=${SECRET}/kill`, { confirm: true });
    expect(notLive.status).toBe(404);
    await noSecret(notLive, 'kill not_live');
  });
});
