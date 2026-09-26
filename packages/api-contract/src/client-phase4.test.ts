import { describe, expect, it } from 'vitest';
import {
  type ApiRequester,
  githubClient,
  reviewClient,
  shipClient,
  worktreesClient,
} from './client-phase4.ts';

describe('phase 4 client', () => {
  it('maps methods to routes', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const req: ApiRequester = async (method, path, opts) => {
      calls.push([method, path, opts?.body ?? opts?.query ?? null]);
      return undefined as never;
    };
    const c = { ...worktreesClient(req), ...reviewClient(req), ...shipClient(req), ...githubClient(req) };
    await c.worktreesArchive({ path: '/w', confirm: true, confirmExternal: false });
    await c.diffGet({ cwd: '/w' });
    await c.checkpointsRewind('id1', { confirm: true });
    await c.reviewComments('claude', 's1', {
      comments: [{ file: 'a', line: 1, side: 'new', body: 'x' }],
      deliver: 'text',
      confirm: false,
    });
    await c.planReject('claude', 's1', { feedback: 'no', confirm: true });
    await c.githubPr('o/r', 3);
    expect(calls).toEqual([
      ['POST', '/api/worktrees/archive', { path: '/w', confirm: true, confirmExternal: false }],
      ['GET', '/api/diff', { cwd: '/w' }],
      ['POST', '/api/checkpoints/id1/rewind', { confirm: true }],
      [
        'POST',
        '/api/review/claude/s1/comments',
        { comments: [{ file: 'a', line: 1, side: 'new', body: 'x' }], deliver: 'text', confirm: false },
      ],
      ['POST', '/api/sessions/claude/s1/plan/reject', { feedback: 'no', confirm: true }],
      ['GET', '/api/github/pr', { repo: 'o/r', number: 3 }],
    ]);
  });
});
