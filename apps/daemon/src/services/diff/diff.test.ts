import { join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempRepo, type TempRepo } from '../../../test/git-fixture.ts';
import { createTestContext } from '../../../test/helpers.ts';
import { memoryAudit, stubSessions } from '../../../test/stubs.ts';
import { createDiffService } from './diff.ts';

let repo: TempRepo;
let disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers) d();
  disposers = [];
  repo?.cleanup();
});

const lines = (n: number, change: Record<number, string> = {}) =>
  `${Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;

function setup() {
  repo = makeTempRepo();
  repo.write('src/long.ts', lines(30));
  repo.commitAll('add long file');
  const wt = join(repo.root, 'wt');
  repo.git('worktree', 'add', '-b', 'feat/SAF-11-diff', wt, 'main');
  const g = (...args: string[]) => repo.git('-C', wt, ...args);
  const w = (rel: string, body: string) => repo.write(join('..', 'wt', rel), body);
  const cfg = OrcConfig.parse({});
  const audit = memoryAudit();
  const ctx = createTestContext({ config: () => cfg, audit, sessions: stubSessions([]) });
  disposers.push(() => ctx.dispose());
  return { svc: createDiffService(ctx), wt, g, w, audit };
}

describe('DiffService.diff', () => {
  it('compares merge-base with the live worktree, including commits and untracked files', async () => {
    const { svc, wt, g, w } = setup();
    w('src/a.ts', 'export const a = 9;\nexport const b = 2;\nexport const c = 3;\n');
    g('commit', '-qam', 'change a');
    w('src/long.ts', lines(30, { 2: 'CHANGED 2' }));
    w('src/fresh.ts', 'export const fresh = true;\n');
    const d = await svc.diff(wt);
    expect(d.to).toBe('WORKTREE');
    expect(d.from).toBe(await svc.mergeBase(wt));
    expect(d.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['src/a.ts', 'modified', 1, 1],
      ['src/fresh.ts', 'added', 1, 0],
      ['src/long.ts', 'modified', 1, 1],
    ]);
    expect(d.additions).toBe(3);
    expect(d.deletions).toBe(2);
    expect(g('status', '--porcelain=v1')).toContain('?? src/fresh.ts');
  });

  it('diffs two explicit refs', async () => {
    const { svc, wt, g, w } = setup();
    const base = g('rev-parse', 'HEAD').trim();
    w('README.md', '# changed\n');
    g('commit', '-qam', 'readme');
    const d = await svc.diff(wt, { from: base, to: 'HEAD' });
    expect(d.files.map((f) => f.path)).toEqual(['README.md']);
  });
});

describe('DiffService.revert', () => {
  it('reverts a single hunk and leaves the other one', async () => {
    const { svc, wt, g, w, audit } = setup();
    const head = g('rev-parse', 'HEAD').trim();
    w('src/long.ts', lines(30, { 2: 'CHANGED 2', 28: 'CHANGED 28' }));
    const before = await svc.diff(wt);
    expect(before.files[0]?.hunks).toHaveLength(2);
    await expect(svc.revert(wt, 'src/long.ts', { hunkIndex: 0 })).resolves.toEqual({
      reverted: 'src/long.ts#0',
    });
    const after = repo.read('../wt/src/long.ts');
    expect(after).toContain('line 2\n');
    expect(after).toContain('CHANGED 28');
    expect(g('rev-parse', 'HEAD').trim()).toBe(head);
    expect(g('for-each-ref', '--format=%(refname)', 'refs/orchestrator/reverts/')).toMatch(
      /refs\/orchestrator\/reverts\/\d+/,
    );
    expect(audit.entries.map((e) => [e.action, e.result])).toContainEqual(['git.revert', 'ok']);
  });

  it('reverts a whole file, including committed changes, and deletes added files', async () => {
    const { svc, wt, g, w } = setup();
    w('src/a.ts', 'committed change\n');
    g('commit', '-qam', 'change');
    w('src/added.ts', 'new\n');
    await svc.revert(wt, 'src/a.ts', {});
    await svc.revert(wt, 'src/added.ts', {});
    expect(repo.read('../wt/src/a.ts')).toBe(
      'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
    );
    expect(repo.exists('../wt/src/added.ts')).toBe(false);
    expect(g('status', '--porcelain=v1')).toContain(' M src/a.ts');
  });

  it('refuses paths outside the worktree and missing hunks', async () => {
    const { svc, wt, w } = setup();
    await expect(svc.revert(wt, '../repo/README.md', {})).rejects.toMatchObject({
      code: 'forbidden_git_args',
    });
    w('src/long.ts', lines(30, { 5: 'x' }));
    await expect(svc.revert(wt, 'src/long.ts', { hunkIndex: 3 })).rejects.toMatchObject({
      code: 'hunk_not_found',
    });
  });
});
