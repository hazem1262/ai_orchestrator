import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { makeSession, stubSessions } from '../../../test/stubs.ts';
import { resolveWorktrees } from './discover.ts';
import { collectCandidates, findGitFileDirs, readGithubRepoPaths } from './sources.ts';

let repo: TempRepo;
let disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
  repo.cleanup();
});

function setup() {
  repo = makeTempRepo();
  const other = makeTempRepo();
  // worktree inside .worktrees
  repo.git(
    'worktree',
    'add',
    '-b',
    'feat/SAF-1-inside',
    join(repo.dir, '.worktrees', 'feat-SAF-1-inside'),
    'main',
  );
  // sibling worktree next to the main checkout
  repo.git('worktree', 'add', '-b', 'fix/SAF-2-sibling', join(repo.root, 'repo-sibling'), 'main');
  // scratchpad worktree
  const scratchRoot = join(repo.root, 'tmp');
  const scratchWt = join(scratchRoot, 'claude-501', '-Users-test-Wakecap', 'uuid-1', 'scratchpad', 'wt');
  mkdirSync(join(scratchWt, '..'), { recursive: true });
  repo.git('worktree', 'add', '--detach', scratchWt, 'main');
  // a stale folder in .worktrees that git no longer knows
  mkdirSync(join(repo.dir, '.worktrees', 'stale'), { recursive: true });
  writeFileSync(join(repo.dir, '.worktrees', 'stale', '.git'), 'gitdir: /nowhere/at/all\n');
  // ~/.claude.json with an auth-looking key that must be ignored
  const claudeJson = join(repo.root, 'claude.json');
  writeFileSync(
    claudeJson,
    JSON.stringify({
      oauthAccount: { emailAddress: 'x@example.com' },
      githubRepoPaths: { 'o/other': [other.dir, '/does/not/exist'] },
    }),
  );
  const cfg = OrcConfig.parse({
    projects: [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: [repo.root], repos: [{ path: repo.dir }] }],
    worktrees: { scratchpadRoots: [scratchRoot] },
  });
  const sessions = stubSessions([
    makeSession({ id: 's1', startCwd: join(other.dir, 'src'), cwds: [join(other.dir, 'src')] }),
  ]);
  const ctx = createTestContext({ config: () => cfg, sessions });
  disposers.push(() => ctx.dispose());
  return { ctx, claudeJson, other, scratchRoot, scratchWt: realpathSync(scratchWt) };
}

describe('readGithubRepoPaths', () => {
  it('returns only the githubRepoPaths values', () => {
    const { claudeJson, other } = setup();
    expect(readGithubRepoPaths(claudeJson)).toEqual([other.dir, '/does/not/exist']);
    other.cleanup();
  });

  it('returns [] when the file is missing or malformed', () => {
    repo = makeTempRepo();
    expect(readGithubRepoPaths(join(repo.root, 'nope.json'))).toEqual([]);
    writeFileSync(join(repo.root, 'bad.json'), '{not json');
    expect(readGithubRepoPaths(join(repo.root, 'bad.json'))).toEqual([]);
  });
});

describe('findGitFileDirs', () => {
  it('finds linked worktrees under claude-* folders only', () => {
    const { scratchRoot, scratchWt, other } = setup();
    mkdirSync(join(scratchRoot, 'unrelated', 'x'), { recursive: true });
    writeFileSync(join(scratchRoot, 'unrelated', 'x', '.git'), 'gitdir: /x\n');
    expect(findGitFileDirs(scratchRoot, { maxDepth: 6, namePrefix: 'claude-' })).toEqual([scratchWt]);
    other.cleanup();
  });
});

describe('collectCandidates + resolveWorktrees', () => {
  it('discovers config, worktree-dir, sibling, scratchpad, claude-json and session repos', async () => {
    const { ctx, claudeJson, other, scratchRoot, scratchWt } = setup();
    const candidates = await collectCandidates(ctx, { claudeJson });
    const found = await resolveWorktrees(candidates, { scratchpadRoots: [scratchRoot] });
    const byPath = Object.fromEntries(found.map((w) => [w.path, w]));

    expect(byPath[repo.dir]).toMatchObject({
      isMain: true,
      origin: 'config',
      branch: 'main',
      repo: repo.dir,
    });
    expect(byPath[join(repo.dir, '.worktrees', 'feat-SAF-1-inside')]).toMatchObject({
      origin: 'worktree-dir',
      branch: 'feat/SAF-1-inside',
      repo: repo.dir,
    });
    expect(byPath[join(repo.root, 'repo-sibling')]).toMatchObject({
      origin: 'sibling',
      branch: 'fix/SAF-2-sibling',
    });
    expect(byPath[scratchWt]).toMatchObject({ origin: 'scratchpad', detached: true, branch: '(detached)' });
    expect(byPath[other.dir]).toMatchObject({ isMain: true, origin: 'claude-json' });
    expect(found.some((w) => w.path.endsWith('stale'))).toBe(false);
    expect(found.filter((w) => w.path === other.dir)).toHaveLength(1);
    other.cleanup();
  });
});
