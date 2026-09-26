import type { PrStatus, WorktreeView } from '@orc/core';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { applyLiveEvent } from './live-events.ts';

describe('applyLiveEvent (phase 4)', () => {
  it('upserts and removes worktrees in every cached list and updates PR status', () => {
    const qc = new QueryClient();
    const w = { path: '/w', branch: 'feat/x', state: 'active' } as WorktreeView;
    qc.setQueryData(['worktrees', { state: 'active' }], [] as WorktreeView[]);
    applyLiveEvent(qc, { type: 'worktree.updated', worktree: w });
    expect(qc.getQueryData(['worktrees', { state: 'active' }])).toEqual([w]);
    applyLiveEvent(qc, { type: 'worktree.updated', worktree: { ...w, branch: 'feat/y' } });
    expect((qc.getQueryData(['worktrees', { state: 'active' }]) as WorktreeView[])[0]?.branch).toBe('feat/y');
    applyLiveEvent(qc, { type: 'worktree.removed', path: '/w' });
    expect(qc.getQueryData(['worktrees', { state: 'active' }])).toEqual([]);
    const s = { pr: { repo: 'o/r', number: 1, url: 'u' }, state: 'merged' } as PrStatus;
    applyLiveEvent(qc, { type: 'pr.updated', status: s });
    expect(qc.getQueryData(['pr', 'o/r', 1])).toEqual(s);
  });
});
