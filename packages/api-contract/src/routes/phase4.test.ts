import { describe, expect, it } from 'vitest';
import { OrcConfig } from '../config.ts';
import { PlanRejectBody } from './plan.ts';
import { DiffRevertBody, ReviewCommentsBody } from './review.ts';
import { PrStatusSchema, ShipMergeBody, ShipPrBody } from './ship.ts';
import { CreateWorktreeBody, WorktreeArchiveBody, WorktreeViewSchema } from './worktrees.ts';

describe('phase 4 schemas', () => {
  it('adds github and worktrees config defaults', () => {
    const c = OrcConfig.parse({});
    expect(c.github).toEqual({
      enabled: true,
      pollSeconds: 90,
      ticketUrlTemplate: 'https://linear.app/wakecap/issue/{ticket}',
      protectedBranches: ['main', 'master', 'develop', 'staging', 'testing', 'production'],
    });
    expect(c.worktrees.autoArchiveOnMerge).toBe(true);
    expect(c.worktrees.scratchpadRoots).toEqual(['/private/tmp']);
    expect(c.worktrees.implementTicketMode).toBe('conductor');
    expect(c.worktrees.checkpointsPerSession).toBe(200);
  });

  it('rejects a poll interval under 30 s', () => {
    expect(() => OrcConfig.parse({ github: { pollSeconds: 5 } })).toThrow();
  });

  it('parses a create body with an optional launch', () => {
    const b = CreateWorktreeBody.parse({
      repo: '/r',
      base: 'main',
      type: 'feat',
      ticket: 'SAF-1',
      slug: 'x',
      confirm: true,
    });
    expect(b.launch).toBeUndefined();
    expect(b.runSetup).toBe(true);
    expect(() =>
      CreateWorktreeBody.parse({ repo: '/r', base: 'main', type: 'feature', ticket: null, slug: 'x' }),
    ).toThrow();
  });

  it('defaults confirm flags to false', () => {
    const a = WorktreeArchiveBody.parse({ path: '/r/.worktrees/x' });
    expect(a.confirm).toBe(false);
    expect(a.confirmExternal).toBe(false);
  });

  it('parses a worktree view', () => {
    const v = WorktreeViewSchema.parse({
      path: '/r/.worktrees/feat-SAF-1-x',
      repo: '/r',
      branch: 'feat/SAF-1-x',
      base: 'main',
      ticket: 'SAF-1',
      dirty: false,
      prUrl: null,
      state: 'active',
      createdByApp: true,
      head: 'abc',
      isMain: false,
      origin: 'app',
      sessionPks: [],
      projectId: 'wakecap',
      prStatus: null,
      updatedAt: '2026-09-17T00:00:00.000Z',
    });
    expect(v.origin).toBe('app');
  });

  it('limits review comments and requires text', () => {
    expect(() => ReviewCommentsBody.parse({ comments: [], deliver: 'text' })).toThrow();
    expect(() =>
      ReviewCommentsBody.parse({
        comments: [{ file: 'a.ts', line: 1, side: 'new', body: '' }],
        deliver: 'text',
      }),
    ).toThrow();
    const ok = ReviewCommentsBody.parse({
      comments: [{ file: 'a.ts', line: 1, side: 'new', body: 'rename' }],
      deliver: 'session',
    });
    expect(ok.confirm).toBe(false);
  });

  it('parses revert, PR, merge and plan bodies', () => {
    expect(DiffRevertBody.parse({ cwd: '/r', file: 'a.ts', confirm: true }).hunkIndex).toBeUndefined();
    expect(ShipPrBody.parse({ cwd: '/r', title: 't', body: 'b', base: 'main', confirm: true }).draft).toBe(
      false,
    );
    expect(() =>
      ShipMergeBody.parse({
        pr: { repo: 'o/r', number: 1, url: 'u' },
        method: 'fast-forward',
        confirm: true,
      }),
    ).toThrow();
    expect(() => PlanRejectBody.parse({ feedback: '', confirm: true })).toThrow();
  });

  it('parses a PR status', () => {
    const s = PrStatusSchema.parse({
      pr: { repo: 'o/r', number: 3, url: 'https://github.com/o/r/pull/3' },
      state: 'merged',
      title: 't',
      checks: 'success',
      review: 'approved',
      updatedAt: '2026-09-17T00:00:00Z',
      headRef: 'feat/SAF-1-x',
      failedChecks: [],
    });
    expect(s.state).toBe('merged');
  });
});
