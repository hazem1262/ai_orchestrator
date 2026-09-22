import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrcConfig } from '@orc/api-contract';
import { LaunchRequest } from '@orc/api-contract';
import type { LiveState, Session } from '@orc/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLive } from '../../test/fake-live.ts';
import { createFakePty } from '../../test/fake-pty.ts';
import { createTestContext, type TestContext, useTempHomes } from '../../test/helpers.ts';
import { stubSession } from '../live/stub-session.ts';
import { buildLaunchCommand, createLaunchService, LaunchError } from './launch.ts';
import { projectConfigFor } from './projects.ts';
import { createTemplateRegistry } from './templates.ts';

/**
 * Nothing here starts a real process: PTYs come from `createFakePty` (synthetic pids, `kill`
 * only records), observed-session kills go through the injected `killPid` spy, and session-id
 * discovery goes through `createFakeLive`.
 */
const homes = useTempHomes();
let ctx: TestContext;
let pty: ReturnType<typeof createFakePty>;
let live: ReturnType<typeof createFakeLive>;
let root: string;
let cwd: string;
let otherCwd: string;
let cap: number | undefined;
const killPid = vi.fn();

const req = (over: Record<string, unknown> = {}) =>
  LaunchRequest.parse({ source: 'claude', projectId: 'wakecap', cwd, ...over });
const errOf = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

beforeEach(() => {
  pty = createFakePty();
  ctx = createTestContext({ homes, pty });
  live = createFakeLive();
  ctx.live = live;
  ctx.templates = createTemplateRegistry();
  root = mkdtempSync(join(tmpdir(), 'orc-launch-'));
  cwd = join(root, 'wakecap');
  otherCwd = join(root, 'forza');
  mkdirSync(cwd);
  mkdirSync(otherCwd);
  cap = undefined;
  const real = ctx.projects;
  ctx.projects = {
    ...real,
    resolve: (c: string) => (c.startsWith(otherCwd) ? 'forza' : c.startsWith(cwd) ? 'wakecap' : null),
    get: (id: string) => {
      const p = projectConfigFor({ id, name: id, pathPrefix: id === 'forza' ? otherCwd : cwd });
      return cap === undefined ? p : { ...p, maxConcurrentOwned: cap };
    },
    update: (id, patch) => real.update(id, patch),
  };
  const base = ctx.config();
  const cfg: OrcConfig = {
    ...base,
    resumeProfile: { ...base.resumeProfile, claudeCommand: 'claude', codexCommand: 'codex' },
  };
  ctx.config = () => cfg;
  killPid.mockClear();
});

afterEach(() => {
  ctx.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('buildLaunchCommand', () => {
  it('uses the resume profile, model and prompt', () => {
    const cfg = ctx.config();
    expect(buildLaunchCommand(cfg, { source: 'claude', model: 'claude-opus-5', prompt: 'hi' })).toEqual({
      command: 'claude',
      args: ['--dangerously-skip-permissions', '--model', 'claude-opus-5', 'hi'],
    });
    expect(buildLaunchCommand(cfg, { source: 'codex', prompt: '' })).toEqual({ command: 'codex', args: [] });
  });

  it('orders profile args, then --model, then the prompt, for both sources', () => {
    const base = ctx.config();
    const cfg: OrcConfig = {
      ...base,
      resumeProfile: {
        ...base.resumeProfile,
        claudeCommand: '/opt/bin/claude',
        codexCommand: '/opt/bin/codex',
        claudeArgs: ['--a', '1'],
        codexArgs: ['--c'],
      },
    };
    expect(buildLaunchCommand(cfg, { source: 'claude', prompt: 'p' })).toEqual({
      command: '/opt/bin/claude',
      args: ['--a', '1', 'p'],
    });
    expect(buildLaunchCommand(cfg, { source: 'claude', model: 'm', prompt: 'p' })).toEqual({
      command: '/opt/bin/claude',
      args: ['--a', '1', '--model', 'm', 'p'],
    });
    expect(buildLaunchCommand(cfg, { source: 'codex', prompt: 'p' })).toEqual({
      command: '/opt/bin/codex',
      args: ['--c', '--', 'p'],
    });
    expect(buildLaunchCommand(cfg, { source: 'codex', model: 'gpt-5.5', prompt: 'p' })).toEqual({
      command: '/opt/bin/codex',
      args: ['--c', '--model', 'gpt-5.5', '--', 'p'],
    });
    expect(buildLaunchCommand(cfg, { source: 'codex', model: 'gpt-5.5', prompt: '' })).toEqual({
      command: '/opt/bin/codex',
      args: ['--c', '--model', 'gpt-5.5'],
    });
  });
});

describe('LaunchService.launch', () => {
  it('spawns claude in the cwd and discovers the session id', async () => {
    live.pids.set(90000, 's-new');
    const wait = vi.spyOn(live, 'waitForPid');
    const svc = createLaunchService(ctx, { discoverTimeoutMs: 50 });
    const out = await svc.launch(
      req({ templateId: 'wf-implement-ticket', ticket: 'SAF-1787', prompt: 'keep it small' }),
    );
    expect(out).toEqual({ ptyId: 'pty-1', sessionId: 's-new' });
    expect(pty.spawned[0]).toMatchObject({
      command: 'claude',
      cwd,
      args: ['--dangerously-skip-permissions', '/conductor SAF-1787\n\nkeep it small'],
    });
    expect(wait).toHaveBeenCalledWith(90000, 50);
  });

  it('waits 8000 ms for the session id by default', async () => {
    const wait = vi.spyOn(live, 'waitForPid');
    await createLaunchService(ctx).launch(req({ prompt: 'x' }));
    expect(wait).toHaveBeenCalledWith(90000, 8000);
  });

  it('launches codex without waiting for a session id', async () => {
    live.pids.set(90000, 'would-be-wrong');
    const wait = vi.spyOn(live, 'waitForPid');
    const out = await createLaunchService(ctx).launch(
      req({ source: 'codex', prompt: 'second opinion', model: 'gpt-5.5' }),
    );
    expect(out).toEqual({ ptyId: 'pty-1', sessionId: null });
    expect(pty.spawned[0]).toMatchObject({
      command: 'codex',
      args: ['--model', 'gpt-5.5', '--', 'second opinion'],
    });
    expect(wait).not.toHaveBeenCalled();
  });

  // The strategy per CLI comes from probes of codex-cli 0.152.1 and Claude Code 2.1.278 (see
  // CLAUDE_SUBCOMMANDS in launch.ts): codex (clap) reads everything after `--` as the prompt;
  // claude (Commander) still dispatches a subcommand named right after `--`.
  it.each(['logout', 'a', 'apply', 'update', 'completion', 'help'])(
    'passes codex prompt %j after an end-of-options marker, as the last argv element',
    async (prompt) => {
      await createLaunchService(ctx).launch(req({ source: 'codex', prompt, model: 'gpt-5.5' }));
      expect(pty.spawned[0]?.args).toEqual(['--model', 'gpt-5.5', '--', prompt]);
    },
  );

  it.each([
    'update',
    'upgrade',
    'mcp list',
    'plugins',
    'kill 3',
    '  install\tlatest',
    'doctor\nplease',
    'auth',
  ])('refuses a claude prompt %j whose first word is a claude subcommand', async (prompt) => {
    const err = await errOf(createLaunchService(ctx).launch(req({ prompt })));
    expect(err).toBeInstanceOf(LaunchError);
    expect(err).toMatchObject({ status: 400, code: 'validation_failed' });
    expect(pty.spawned).toHaveLength(0);
  });

  it('lets a claude prompt through when a subcommand name is not its first word', async () => {
    const svc = createLaunchService(ctx, { discoverTimeoutMs: 1 });
    await svc.launch(req({ prompt: 'updates the readme' }));
    await svc.launch(req({ prompt: 'please update the readme' }));
    await svc.launch(req({ prompt: 'help' }));
    expect(pty.spawned.map((p) => p.args.at(-1))).toEqual([
      'updates the readme',
      'please update the readme',
      'help',
    ]);
  });

  it('treats compare: [] as absent', async () => {
    await expect(
      createLaunchService(ctx, { discoverTimeoutMs: 1 }).launch(req({ compare: [], prompt: 'x' })),
    ).resolves.toMatchObject({ ptyId: 'pty-1' });
  });

  it('returns sessionId null when discovery times out', async () => {
    live.waitForPid = (_pid, ms) => new Promise((r) => setTimeout(() => r(null), ms));
    const wait = vi.spyOn(live, 'waitForPid');
    const out = await createLaunchService(ctx, { discoverTimeoutMs: 10 }).launch(req({ prompt: 'x' }));
    expect(out).toEqual({ ptyId: 'pty-1', sessionId: null });
    expect(wait).toHaveBeenCalledWith(90000, 10);
  });

  it('returns sessionId null when no live tracker is wired', async () => {
    ctx.live = undefined;
    const out = await createLaunchService(ctx, { discoverTimeoutMs: 10 }).launch(req({ prompt: 'x' }));
    expect(out).toEqual({ ptyId: 'pty-1', sessionId: null });
  });

  it.each([
    [{ planApproval: true }, 'planApproval'],
    [{ worktree: { repo: '/r', base: 'main', type: 'feat', slug: 'x' } }, 'worktree'],
    [{ compare: [{ source: 'claude' }] }, 'compare'],
  ])('rejects %j with 501 until later phases', async (over, field) => {
    const err = await errOf(createLaunchService(ctx).launch(req(over)));
    expect(err).toBeInstanceOf(LaunchError);
    expect(err).toMatchObject({ status: 501, code: 'not_implemented', details: { field } });
    expect(pty.spawned).toHaveLength(0);
  });

  it('validates cwd, prompt and template variables', async () => {
    const svc = createLaunchService(ctx);
    const file = join(root, 'a-file');
    writeFileSync(file, 'x');
    expect(await errOf(svc.launch(req({ cwd: join(cwd, 'missing') })))).toMatchObject({
      status: 400,
      code: 'cwd_not_found',
    });
    expect(await errOf(svc.launch(req({ cwd: 'relative/path' })))).toMatchObject({
      status: 400,
      code: 'cwd_not_found',
    });
    expect(await errOf(svc.launch(req({ cwd: file })))).toMatchObject({ status: 400, code: 'cwd_not_found' });
    expect(await errOf(svc.launch(req({ prompt: '--help' })))).toMatchObject({
      status: 400,
      code: 'validation_failed',
    });
    expect(await errOf(svc.launch(req({ prompt: '  -p x' })))).toMatchObject({
      status: 400,
      code: 'validation_failed',
    });
    expect(await errOf(svc.launch(req({ templateId: 'wf-review-pr' })))).toMatchObject({
      status: 400,
      code: 'template_var_missing',
      details: { missing: ['prUrl'] },
    });
    expect(await errOf(svc.launch(req({ templateId: 'nope' })))).toMatchObject({
      status: 404,
      code: 'template_not_found',
    });
    expect(pty.spawned).toHaveLength(0);
  });

  it('surfaces template_var_invalid as its own 400 code, not template_var_missing', async () => {
    const svc = createLaunchService(ctx);
    const viaTicket = await errOf(
      svc.launch(req({ templateId: 'wf-investigate', ticket: 'SAF-1\u001b[2J' })),
    );
    expect(viaTicket).toBeInstanceOf(LaunchError);
    expect(viaTicket).toMatchObject({ status: 400, code: 'template_var_invalid' });
    const viaVars = await errOf(
      svc.launch(req({ templateId: 'wf-review-pr', vars: { prUrl: 'https://x/1 rm' } })),
    );
    expect(viaVars).toMatchObject({ status: 400, code: 'template_var_invalid' });
    expect((viaTicket as LaunchError).details).toBeUndefined();
    expect((viaVars as LaunchError).details).toBeUndefined();
    expect(pty.spawned).toHaveLength(0);
  });

  it('passes the composed prompt verbatim as the last argv element, never through a shell', async () => {
    const prompt = 'fix $(rm -rf ~) && echo "done"; `id` | tee out > /dev/null';
    await createLaunchService(ctx, { discoverTimeoutMs: 1 }).launch(req({ prompt, model: 'opus' }));
    const spawned = pty.spawned[0];
    expect(spawned?.command).toBe('claude');
    expect(spawned?.args).toEqual(['--dangerously-skip-permissions', '--model', 'opus', prompt]);
    expect(spawned?.args.at(-1)).toBe(prompt);
  });

  it('puts the rendered template before the user prompt in the one last argument', async () => {
    const svc = createLaunchService(ctx, { discoverTimeoutMs: 1 });
    await svc.launch(
      req({ templateId: 'wf-investigate', ticket: 'SAF-9', model: 'opus', prompt: '  look at logs  ' }),
    );
    expect(pty.spawned[0]?.args).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'opus',
      '/investigate SAF-9\n\nlook at logs',
    ]);
    await svc.launch(req({ templateId: 'wf-investigate', ticket: 'SAF-9' }));
    expect(pty.spawned[1]?.args).toEqual(['--dangerously-skip-permissions', '/investigate SAF-9']);
  });

  it('adds no empty argument when there is no prompt', async () => {
    await createLaunchService(ctx, { discoverTimeoutMs: 1 }).launch(req({}));
    expect(pty.spawned[0]?.args).toEqual(['--dangerously-skip-permissions']);
  });

  it('enforces the per-project concurrency cap with 429', async () => {
    cap = 1;
    const svc = createLaunchService(ctx, { discoverTimeoutMs: 10 });
    const first = await svc.launch(req({ prompt: 'one' }));
    expect(svc.ownedCount('wakecap')).toBe(1);
    const err = await errOf(svc.launch(req({ prompt: 'two' })));
    expect(err).toBeInstanceOf(LaunchError);
    expect(err).toMatchObject({
      status: 429,
      code: 'concurrency_limit',
      details: { projectId: 'wakecap', max: 1, running: 1 },
    });
    expect(pty.spawned).toHaveLength(1);
    pty.kill(first.ptyId);
    await expect(svc.launch(req({ prompt: 'three' }))).resolves.toMatchObject({ ptyId: 'pty-2' });
  });

  it('defaults the cap to the project maxConcurrentOwned of 6', async () => {
    const svc = createLaunchService(ctx, { discoverTimeoutMs: 1 });
    for (let i = 0; i < 6; i++) await svc.launch(req({ prompt: `n${i}` }));
    expect(await errOf(svc.launch(req({ prompt: 'seventh' })))).toMatchObject({
      status: 429,
      code: 'concurrency_limit',
      details: { projectId: 'wakecap', max: 6, running: 6 },
    });
  });

  it('counts both configured agent commands toward the cap', async () => {
    cap = 2;
    pty.spawn({ command: 'claude', args: [], cwd });
    pty.spawn({ command: 'codex', args: [], cwd });
    const svc = createLaunchService(ctx, { discoverTimeoutMs: 1 });
    expect(svc.ownedCount('wakecap')).toBe(2);
    expect(await errOf(svc.launch(req({ source: 'codex', prompt: 'x' })))).toMatchObject({
      status: 429,
      details: { projectId: 'wakecap', max: 2, running: 2 },
    });
  });

  it('does not count non-agent PTYs', async () => {
    cap = 1;
    pty.spawn({ command: 'bash', args: ['-lc', 'pnpm dev'], cwd });
    pty.spawn({ command: '/bin/zsh', args: [], cwd });
    const svc = createLaunchService(ctx, { discoverTimeoutMs: 1 });
    expect(svc.ownedCount('wakecap')).toBe(0);
    await expect(svc.launch(req({ prompt: 'x' }))).resolves.toMatchObject({ ptyId: 'pty-3' });
  });

  it('does not count agent PTYs of another project or ones that exited', async () => {
    cap = 1;
    pty.spawn({ command: 'claude', args: [], cwd: otherCwd });
    const exited = pty.spawn({ command: 'claude', args: [], cwd });
    pty.kill(exited.id);
    const svc = createLaunchService(ctx, { discoverTimeoutMs: 1 });
    expect(svc.ownedCount('wakecap')).toBe(0);
    expect(svc.ownedCount('forza')).toBe(1);
    await expect(svc.launch(req({ prompt: 'x' }))).resolves.toMatchObject({ ptyId: 'pty-3' });
    expect(await errOf(svc.launch(req({ projectId: 'forza', cwd: otherCwd, prompt: 'y' })))).toMatchObject({
      status: 429,
      details: { projectId: 'forza', max: 1, running: 1 },
    });
  });

  it('counts and caps by the project the cwd resolves to, not the request projectId', async () => {
    cap = 1;
    pty.spawn({ command: 'claude', args: [], cwd });
    const svc = createLaunchService(ctx, { discoverTimeoutMs: 1 });
    expect(await errOf(svc.launch(req({ projectId: null, prompt: 'x' })))).toMatchObject({
      status: 429,
      code: 'concurrency_limit',
      details: { projectId: 'wakecap', max: 1, running: 1 },
    });
    expect(pty.spawned).toHaveLength(1);
  });

  it('rejects a projectId that disagrees with the project its cwd resolves to', async () => {
    cap = 1;
    pty.spawn({ command: 'claude', args: [], cwd });
    const svc = createLaunchService(ctx, { discoverTimeoutMs: 1 });
    for (const [projectId, dir] of [
      ['bogus', cwd],
      ['forza', cwd],
      ['wakecap', otherCwd],
      ['wakecap', root],
    ] as const) {
      const err = await errOf(svc.launch(req({ projectId, cwd: dir, prompt: 'x' })));
      expect(err, `${projectId} ${dir}`).toBeInstanceOf(LaunchError);
      expect(err, `${projectId} ${dir}`).toMatchObject({ status: 400, code: 'validation_failed' });
      expect((err as Error).message).toContain(`"${projectId}"`);
    }
    expect((await errOf(svc.launch(req({ projectId: 'bogus', prompt: 'x' })))) as Error).toHaveProperty(
      'message',
      'projectId "bogus" does not match the project its cwd resolves to ("wakecap")',
    );
    expect(pty.spawned).toHaveLength(1);
  });

  it('lets exactly one of two concurrent launches through at cap - 1', async () => {
    cap = 2;
    pty.spawn({ command: 'claude', args: [], cwd });
    const svc = createLaunchService(ctx, { discoverTimeoutMs: 1 });
    const results = await Promise.allSettled([
      svc.launch(req({ prompt: 'a' })),
      svc.launch(req({ prompt: 'b' })),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toMatchObject({ status: 429, code: 'concurrency_limit' });
    expect(pty.spawned).toHaveLength(2);
    expect(svc.ownedCount('wakecap')).toBe(2);
  });
});

describe('LaunchService.kill', () => {
  const liveState = (over: Partial<LiveState>): LiveState => ({
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
  const s = (id: string, l: Partial<LiveState>): Session => ({
    ...stubSession({ source: 'claude', id, cwd, startedAt: '', projectId: 'wakecap', name: id }),
    live: liveState(l),
  });

  it('kills owned sessions through the PTY and observed ones by pid', async () => {
    const info = pty.spawn({ command: 'claude', args: [], cwd });
    live.sessions = [
      s('owned', { ownership: 'owned', ptyId: info.id, pid: info.pid }),
      s('observed', {}),
      s('gone', { status: 'ended' }),
    ];
    const svc = createLaunchService(ctx, { killPid, liveness: { isAlive: async () => true } });
    await expect(svc.kill('claude', 'owned')).resolves.toEqual({ killed: 'pty' });
    expect(pty.killed).toEqual([{ id: info.id, signal: 'SIGTERM' }]);
    expect(killPid).not.toHaveBeenCalled();
    await expect(svc.kill('claude', 'observed')).resolves.toEqual({ killed: 'pid' });
    expect(killPid).toHaveBeenCalledWith(4242);
    expect(killPid).toHaveBeenCalledTimes(1);
    expect(pty.killed).toHaveLength(1);
    expect(await errOf(svc.kill('claude', 'gone'))).toMatchObject({ status: 404, code: 'not_live' });
    expect(await errOf(svc.kill('claude', 'unknown'))).toMatchObject({ status: 404, code: 'not_live' });
    expect(killPid).toHaveBeenCalledTimes(1);
  });

  it('refuses an ended owned session and an observed one with no pid', async () => {
    const info = pty.spawn({ command: 'claude', args: [], cwd });
    live.sessions = [
      s('owned-ended', { ownership: 'owned', ptyId: info.id, pid: info.pid, status: 'ended' }),
      s('no-pid', { pid: null }),
      { ...s('not-live', {}), live: null },
    ];
    const svc = createLaunchService(ctx, { killPid });
    for (const id of ['owned-ended', 'no-pid', 'not-live']) {
      const err = await errOf(svc.kill('claude', id));
      expect(err, id).toBeInstanceOf(LaunchError);
      expect(err, id).toMatchObject({ status: 404, code: 'not_live' });
    }
    expect(pty.killed).toEqual([]);
    expect(killPid).not.toHaveBeenCalled();
  });

  const PROC_START = 'Mon Sep  1 09:00:00 2026';
  const writeRegistry = (pid: number, sessionId: string, procStart: string | null) => {
    const dir = join(ctx.paths.claudeHome, 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, procStart }));
  };

  it('re-checks liveness with the registry procStart just before killing an observed pid', async () => {
    writeRegistry(4242, 'observed', PROC_START);
    writeRegistry(4243, 'observed', 'Tue Sep  2 10:00:00 2026');
    live.sessions = [s('observed', {})];
    const isAlive = vi.fn(async () => true);
    const svc = createLaunchService(ctx, { killPid, liveness: { isAlive } });
    await expect(svc.kill('claude', 'observed')).resolves.toEqual({ killed: 'pid' });
    expect(isAlive).toHaveBeenCalledWith(4242, PROC_START);
    expect(killPid).toHaveBeenCalledWith(4242);
  });

  it('answers not_live and sends no signal when the pid no longer belongs to the session', async () => {
    writeRegistry(4242, 'observed', PROC_START);
    live.sessions = [s('observed', {}), { ...s('cx', {}), source: 'codex', id: 'cx' }];
    const isAlive = vi.fn(async () => false);
    const svc = createLaunchService(ctx, { killPid, liveness: { isAlive } });
    expect(await errOf(svc.kill('claude', 'observed'))).toMatchObject({ status: 404, code: 'not_live' });
    expect(await errOf(svc.kill('codex', 'cx'))).toMatchObject({ status: 404, code: 'not_live' });
    expect(isAlive).toHaveBeenCalledWith(4242, null);
    expect(killPid).not.toHaveBeenCalled();
  });

  it('maps ESRCH from the kill to 404 not_live and rethrows anything else', async () => {
    live.sessions = [s('observed', {})];
    const esrch = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    const eperm = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    const liveness = { isAlive: async () => true };
    const gone = createLaunchService(ctx, {
      liveness,
      killPid: () => {
        throw esrch;
      },
    });
    expect(await errOf(gone.kill('claude', 'observed'))).toMatchObject({ status: 404, code: 'not_live' });
    const denied = createLaunchService(ctx, {
      liveness,
      killPid: () => {
        throw eperm;
      },
    });
    expect(await errOf(denied.kill('claude', 'observed'))).toBe(eperm);
  });

  it('answers not_live when no live tracker is wired', async () => {
    ctx.live = undefined;
    expect(await errOf(createLaunchService(ctx, { killPid }).kill('claude', 'x'))).toMatchObject({
      status: 404,
      code: 'not_live',
    });
    expect(killPid).not.toHaveBeenCalled();
  });
});
