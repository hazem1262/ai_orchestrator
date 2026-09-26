import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { getWorktree } from '../../db/repos/worktrees.ts';
import { globToRegExp } from './glob.ts';
import type { WorktreeDeps } from './worktree-read.ts';
import { createWorktree, openWorktree, runWorktreeScript } from './worktree-write.ts';

let repo: TempRepo;
let disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
  repo?.cleanup();
});

function setup(repoOverrides: Record<string, unknown> = {}) {
  repo = makeTempRepo();
  repo.write('.gitignore', '.env\nnode_modules/\n.worktrees/\nconfig/*.Development.json\n');
  repo.commitAll('ignore dev settings');
  repo.write('.env', 'API_URL=http://localhost\n');
  repo.write('config/appsettings.Development.json', '{"x":1}\n');
  repo.write('node_modules/big/index.js', 'module.exports = 1;\n');
  const cfg = OrcConfig.parse({
    projects: [
      {
        id: 'wakecap',
        name: 'Wakecap',
        pathPrefixes: [repo.root],
        repos: [
          {
            path: repo.dir,
            setup: 'pnpm install',
            run: 'pnpm dev',
            copyGlobs: ['.env', 'config/*.Development.json'],
            ...repoOverrides,
          },
        ],
      },
    ],
  });
  const pty = recordingPty();
  const audit = memoryAudit();
  const opened: Array<[string, string[]]> = [];
  const ctx = createTestContext({ config: () => cfg, pty, audit, sessions: stubSessions([]) });
  disposers.push(() => ctx.dispose());
  const d: WorktreeDeps = {
    ctx,
    now: () => new Date('2026-09-17T10:00:00.000Z'),
    opener: async (c, a) => {
      opened.push([c, a]);
    },
  };
  return { ctx, d, pty, audit, opened };
}

describe('globToRegExp', () => {
  it('handles *, ** and ?', () => {
    expect(globToRegExp('config/*.json').test('config/a.json')).toBe(true);
    expect(globToRegExp('config/*.json').test('config/x/a.json')).toBe(false);
    expect(globToRegExp('**/.env').test('apps/api/.env')).toBe(true);
    expect(globToRegExp('**/.env').test('.env')).toBe(true);
    expect(globToRegExp('file?.txt').test('file1.txt')).toBe(true);
  });
});

describe('createWorktree', () => {
  it('adds the branch in .worktrees, copies ignored files, runs setup and audits', async () => {
    const { ctx, d, pty, audit } = setup();
    const { view, setupPtyId } = await createWorktree(
      d,
      { repo: repo.dir, base: 'main', type: 'feat', ticket: 'saf-12', slug: 'Exclude weekends from SLA' },
      { runSetup: true, actor: 'user' },
    );
    const expected = join(repo.dir, '.worktrees', 'feat-SAF-12-exclude-weekends-sla');
    expect(view).toMatchObject({
      path: expected,
      branch: 'feat/SAF-12-exclude-weekends-sla',
      base: 'main',
      ticket: 'SAF-12',
      createdByApp: true,
      origin: 'app',
    });
    expect(readFileSync(join(expected, '.env'), 'utf8')).toBe('API_URL=http://localhost\n');
    expect(existsSync(join(expected, 'config/appsettings.Development.json'))).toBe(true);
    expect(existsSync(join(expected, 'node_modules'))).toBe(false);
    expect(setupPtyId).toBe('pty-1');
    expect(pty.spawned[0]).toMatchObject({ cwd: expected, args: ['-lc', 'pnpm install'] });
    expect(getWorktree(ctx.db, expected)?.createdByApp).toBe(true);
    expect(audit.entries.map((e) => [e.action, e.result])).toEqual([['worktree.create', 'ok']]);
  });

  it('refuses to create a second worktree for the same branch', async () => {
    const { d, audit } = setup();
    const input = { repo: repo.dir, base: 'main', type: 'fix' as const, ticket: 'SAF-3', slug: 'dup' };
    await createWorktree(d, input, { runSetup: false, actor: 'user' });
    await expect(createWorktree(d, input, { runSetup: false, actor: 'user' })).rejects.toMatchObject({
      code: 'worktree_exists',
    });
    expect(audit.entries.at(-1)).toMatchObject({ action: 'worktree.create', result: 'error' });
  });

  it('reuses a branch that /conductor already created', async () => {
    const { d } = setup();
    repo.git('branch', 'feat/SAF-4-by-conductor', 'main');
    const { view } = await createWorktree(
      d,
      { repo: repo.dir, base: 'main', type: 'feat', ticket: 'SAF-4', slug: 'by conductor' },
      { runSetup: false, actor: 'user' },
    );
    expect(view.branch).toBe('feat/SAF-4-by-conductor');
    expect(repo.git('worktree', 'list')).toContain('feat-SAF-4-by-conductor');
  });

  it('refuses a path that is not a main checkout', async () => {
    const { d } = setup();
    await expect(
      createWorktree(
        d,
        { repo: join(repo.dir, 'src'), base: 'main', type: 'feat', ticket: null, slug: 'x' },
        { runSetup: false, actor: 'user' },
      ),
    ).rejects.toMatchObject({ code: 'not_a_worktree' });
  });
});

describe('runWorktreeScript and openWorktree', () => {
  it('runs the configured script in a PTY and opens VS Code', async () => {
    const { d, pty, audit, opened } = setup();
    const { view } = await createWorktree(
      d,
      { repo: repo.dir, base: 'main', type: 'chore', ticket: null, slug: 'scripts' },
      { runSetup: false, actor: 'user' },
    );
    const { ptyId } = await runWorktreeScript(d, view.path, 'run', 'user');
    expect(ptyId).toBe('pty-1');
    expect(pty.spawned[0]?.args).toEqual(['-lc', 'pnpm dev']);
    await expect(runWorktreeScript(d, view.path, 'archive', 'user')).rejects.toMatchObject({
      code: 'no_script',
    });
    await openWorktree(d, view.path, 'vscode');
    expect(opened).toEqual([['code', ['--new-window', view.path]]]);
    expect(audit.entries.map((e) => e.action)).toEqual([
      'worktree.create',
      'worktree.script',
      'worktree.script',
      'worktree.open',
    ]);
  });
});
