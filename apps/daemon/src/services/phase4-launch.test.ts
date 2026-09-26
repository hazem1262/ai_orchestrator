import { join } from 'node:path';
import { LaunchRequest, OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordingPty } from '../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../test/git-fixture.ts';
import { createTestContext, type TestContext } from '../../test/helpers.ts';
import { memoryAudit, stubSessions, stubTemplates } from '../../test/stubs.ts';
import { createLaunchService } from './launch.ts';
import { applyPlanMode } from './launch-plan-mode.ts';
import { prepareLaunch } from './launch-prepare.ts';
import { createWorktreeService } from './worktree/worktree.ts';

let repo: TempRepo | undefined;
let ctxs: TestContext[] = [];
afterEach(() => {
  for (const c of ctxs) c.dispose();
  ctxs = [];
  repo?.cleanup();
  repo = undefined;
});

describe('applyPlanMode', () => {
  it('swaps bypass mode for plan mode', () => {
    expect(applyPlanMode(['--dangerously-skip-permissions', '--model', 'opus'])).toEqual([
      '--model',
      'opus',
      '--permission-mode',
      'plan',
    ]);
    expect(applyPlanMode(['--permission-mode', 'acceptEdits'])).toEqual(['--permission-mode', 'plan']);
    expect(applyPlanMode(['--permission-mode=bypassPermissions'])).toEqual(['--permission-mode', 'plan']);
  });
});

function setup(setupScript?: string) {
  const r = makeTempRepo();
  repo = r;
  const cfg = OrcConfig.parse({
    projects: [
      {
        id: 'wakecap',
        name: 'Wakecap',
        pathPrefixes: [r.root],
        repos: [{ path: r.dir, ...(setupScript ? { setup: setupScript } : {}) }],
      },
    ],
  });
  const pty = recordingPty();
  const ctx = createTestContext({
    config: () => cfg,
    pty,
    audit: memoryAudit(),
    sessions: stubSessions([]),
    templates: stubTemplates(),
  });
  ctxs.push(ctx);
  // Setup-only: the real project service reads the config saved on disk, not the `config`
  // override, so the launcher's cwd -> project check is pointed at the temp repo here.
  ctx.projects = { ...ctx.projects, resolve: (c: string) => (c.startsWith(r.root) ? 'wakecap' : null) };
  ctx.worktrees = createWorktreeService(ctx);
  return { ctx, pty, repo: r };
}

describe('prepareLaunch', () => {
  it('creates the worktree and moves the cwd into it', async () => {
    const { ctx, repo } = setup();
    const req = LaunchRequest.parse({
      source: 'claude',
      projectId: 'wakecap',
      cwd: repo.dir,
      ticket: 'SAF-70',
      worktree: { repo: repo.dir, base: 'main', type: 'feat', slug: 'plan flow' },
    });
    const out = await prepareLaunch(ctx, req);
    expect(out.cwd).toBe(join(repo.dir, '.worktrees', 'feat-SAF-70-plan-flow'));
    expect(out.worktree).toBeUndefined();
  });

  it('waits for the setup script to exit before returning', async () => {
    const { ctx, pty, repo } = setup('pnpm install');
    const req = LaunchRequest.parse({
      source: 'claude',
      projectId: 'wakecap',
      cwd: repo.dir,
      ticket: 'SAF-71',
      worktree: { repo: repo.dir, base: 'main', type: 'fix', slug: 'wait setup' },
    });
    let done = false;
    const p = prepareLaunch(ctx, req).then((r) => {
      done = true;
      return r;
    });
    await vi.waitFor(() => expect(pty.spawned.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(pty.spawned[0]?.args).toEqual(['-lc', 'pnpm install']);
    // Negative check: give prepareLaunch a chance to (wrongly) resolve before the exit event.
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    ctx.bus.emit({ type: 'pty.exited', ptyId: 'pty-1', code: 0 });
    await p;
    expect(done).toBe(true);
  });

  it('rejects plan approval for Codex', async () => {
    const { ctx, repo } = setup();
    const req = LaunchRequest.parse({
      source: 'codex',
      projectId: 'wakecap',
      cwd: repo.dir,
      planApproval: true,
    });
    await expect(prepareLaunch(ctx, req)).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('launch with Phase 4 fields', () => {
  it('launches Claude in plan mode inside the new worktree', async () => {
    const { ctx, pty, repo } = setup();
    const req = LaunchRequest.parse({
      source: 'claude',
      projectId: 'wakecap',
      cwd: repo.dir,
      prompt: 'plan SAF-72',
      ticket: 'SAF-72',
      planApproval: true,
      worktree: { repo: repo.dir, base: 'main', type: 'feat', slug: 'launch' },
    });
    await createLaunchService(ctx).launch(req);
    const spawn = pty.spawned.at(-1);
    expect(spawn?.cwd).toBe(join(repo.dir, '.worktrees', 'feat-SAF-72-launch'));
    expect(spawn?.args).toContain('--permission-mode');
    expect(spawn?.args[spawn.args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(spawn?.args).not.toContain('--dangerously-skip-permissions');
  });
});
