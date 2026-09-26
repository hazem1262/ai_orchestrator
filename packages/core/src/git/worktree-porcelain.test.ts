import { describe, expect, it } from 'vitest';
import { parseWorktreePorcelain } from './worktree-porcelain.ts';

const OUT = [
  'worktree /Users/test/Wakecap/Backend/infra',
  'HEAD 242bb89333c9f62b76cae3955f6c40ef2a4595a8',
  'branch refs/heads/master',
  '',
  'worktree /Users/test/Wakecap/Backend/infra/.worktrees/feat-ALU-1293-obs-failed-routes',
  'HEAD a04f9ef774f4aba5772385ded34b85fdb69955b0',
  'branch refs/heads/feat/ALU-1293-obs-failed-routes',
  '',
  'worktree /private/tmp/claude-501/x/scratch',
  'HEAD 1111111111111111111111111111111111111111',
  'detached',
  'locked in use',
  '',
  'worktree /gone/away',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/chore/old',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');

describe('parseWorktreePorcelain', () => {
  it('parses every block', () => {
    const w = parseWorktreePorcelain(OUT);
    expect(w).toHaveLength(4);
    expect(w[0]).toEqual({
      path: '/Users/test/Wakecap/Backend/infra',
      head: '242bb89333c9f62b76cae3955f6c40ef2a4595a8',
      branch: 'master',
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    });
    expect(w[1]?.branch).toBe('feat/ALU-1293-obs-failed-routes');
    expect(w[2]).toMatchObject({ branch: null, detached: true, locked: true });
    expect(w[3]?.prunable).toBe(true);
  });

  it('handles a bare main repo and CRLF', () => {
    const w = parseWorktreePorcelain('worktree /srv/r.git\r\nbare\r\n\r\n');
    expect(w).toEqual([
      {
        path: '/srv/r.git',
        head: null,
        branch: null,
        detached: false,
        bare: true,
        locked: false,
        prunable: false,
      },
    ]);
  });

  it('returns [] for empty output', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
  });
});
