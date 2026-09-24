import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FakeGh, useFakeGh } from '../../../test/fake-gh.ts';
import { isolateGitEnv, makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { assertSafeGitArgs, GitError, gh, git, gitOut, mainCheckoutOf, repoRoot } from './exec.ts';

beforeAll(() => isolateGitEnv());

describe('assertSafeGitArgs', () => {
  it.each([
    [['push', '--force']],
    [['push', '-f', 'origin', 'x']],
    [['push', '--force-with-lease']],
    [['push', 'origin', '+main']],
    [['push', 'origin', '--delete', 'main']],
    [['push', '--mirror']],
    [['reset', '--hard', 'HEAD~1']],
    [['clean', '-fd']],
    [['worktree', 'remove', '--force', '/x']],
    [['checkout', '--', '.']],
    [['branch', '-D', 'x']],
    [['stash', 'push']],
    [['update-ref', 'refs/heads/main', 'abc']],
  ])('refuses %j', (args) => {
    expect(() => assertSafeGitArgs(args)).toThrow(GitError);
  });

  it.each([
    [['push', '-u', 'origin', 'HEAD']],
    [['worktree', 'remove', '/x']],
    [['update-ref', 'refs/orchestrator/checkpoints/s/1', 'abc']],
    [['update-ref', '-d', 'refs/orchestrator/checkpoints/s/1']],
    [['stash', 'list']],
    [['status', '--porcelain']],
  ])('allows %j', (args) => {
    expect(() => assertSafeGitArgs(args)).not.toThrow();
  });
});

describe('git helpers in a temp repo', () => {
  let repo: TempRepo;
  afterEach(() => repo.cleanup());

  it('runs git and resolves roots', async () => {
    repo = makeTempRepo();
    expect(await gitOut(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(await repoRoot(`${repo.dir}/src`)).toBe(repo.dir);
    expect(await repoRoot(repo.root)).toBeNull();
    repo.git('worktree', 'add', '-b', 'feat/x', `${repo.root}/wt`, 'main');
    expect(await mainCheckoutOf(`${repo.root}/wt`)).toBe(repo.dir);
  });

  it('throws GitError with stderr on failure unless allowFail', async () => {
    repo = makeTempRepo();
    await expect(gitOut(repo.dir, ['rev-parse', 'nope'])).rejects.toMatchObject({ code: 'git_failed' });
    const r = await git(repo.dir, ['rev-parse', 'nope'], { allowFail: true });
    expect(r.exitCode).not.toBe(0);
  });

  it('refuses a force push before spawning', async () => {
    repo = makeTempRepo();
    await expect(git(repo.dir, ['push', '--force'])).rejects.toMatchObject({ code: 'forbidden_git_args' });
  });
});

describe('gh', () => {
  let fake: FakeGh;
  afterEach(() => fake.restore());

  it('uses the fake gh on PATH', async () => {
    fake = useFakeGh({ authed: false });
    const r = await gh(['auth', 'status']);
    expect(r.exitCode).toBe(1);
    expect(fake.calls()).toEqual([['auth', 'status']]);
  });
});
