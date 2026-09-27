import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import {
  addedLinesDiff,
  defaultBranch,
  diffStat,
  parseRemoteSlug,
  parseShortStat,
} from '../../src/services/git/git-info.ts';
import { initGitRepo } from '../fakes/phase7.ts';

describe('parseShortStat', () => {
  it('parses all parts', () => {
    expect(parseShortStat(' 3 files changed, 10 insertions(+), 2 deletions(-)')).toEqual({
      files: 3,
      insertions: 10,
      deletions: 2,
    });
  });
  it('parses singular and missing parts', () => {
    expect(parseShortStat(' 1 file changed, 1 insertion(+)')).toEqual({
      files: 1,
      insertions: 1,
      deletions: 0,
    });
    expect(parseShortStat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});

describe('diffStat / defaultBranch / addedLinesDiff', () => {
  it('counts committed, uncommitted and untracked changes against the base', async () => {
    const repo = await initGitRepo();
    expect(await defaultBranch(repo)).toBe('main');
    await execa('git', ['-C', repo, 'checkout', '-q', '-b', 'feat/x']);
    writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n// TODO: remove the flag\n');
    await execa('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'change']);
    writeFileSync(join(repo, 'a.ts'), 'export const a = 3;\n// TODO: remove the flag\n');
    writeFileSync(join(repo, 'new.ts'), 'x');
    const stat = await diffStat(repo, 'main');
    expect(stat).toEqual({ files: 1, insertions: 2, deletions: 1, untracked: 1 });
    expect(await addedLinesDiff(repo, 'main')).toContain('+// TODO: remove the flag');
  });
});

describe('parseRemoteSlug', () => {
  it.each([
    ['git@github.com:example-org/svc.git', { owner: 'example-org', name: 'svc' }],
    ['https://github.com/example-org/svc', { owner: 'example-org', name: 'svc' }],
    ['https://github.com/example-org/svc.git', { owner: 'example-org', name: 'svc' }],
    ['/local/path', null],
  ])('%s', (url, expected) => {
    expect(parseRemoteSlug(url)).toEqual(expected);
  });
});
