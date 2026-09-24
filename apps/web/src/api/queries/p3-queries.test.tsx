import type { RawPage, SessionStatsResponse } from '@orc/api-contract';
import type { Session } from '@orc/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useViewModeStore } from '../../stores/view-mode.ts';
import { fakeApi, makeQueryClient, wrapperFor } from '../../test/p3-render.tsx';
import { setApiClientForTests } from '../client.ts';
import { applyP3LiveEvent } from '../live-p3.ts';
import { usePlans } from './safety.ts';
import { detailKeys, useSessionRaw, useSessionStats } from './session-detail.ts';

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null };
const stats: SessionStatsResponse = {
  session: {
    turns: 1,
    wallMs: 1,
    modelMs: 1,
    toolMs: 0,
    ttftMs: null,
    toolCalls: 0,
    toolErrors: 0,
    apiErrors: 0,
    usage: emptyUsage,
    tokensPerSec: null,
    cacheHitRate: null,
  },
  turns: [],
  agents: [],
};

describe('session detail hooks', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('useSessionStats fetches and caches under the session key', async () => {
    const sessionsStats = vi.fn(async () => stats);
    setApiClientForTests(fakeApi({ sessionsStats }));
    const client = makeQueryClient();
    const { result } = renderHook(() => useSessionStats('claude', 's-basic'), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(stats);
    expect(sessionsStats).toHaveBeenCalledWith('claude', 's-basic');
    expect(client.getQueryData(detailKeys.stats('claude', 's-basic'))).toEqual(stats);
  });

  it('useSessionRaw pages by byte offset', async () => {
    const pages: RawPage[] = [
      { path: '/x', items: [{ offset: 0, text: '{}', truncated: false, partial: false }], nextOffset: 10 },
      { path: '/x', items: [{ offset: 10, text: '{}', truncated: false, partial: false }], nextOffset: null },
    ];
    const sessionsRaw = vi.fn(
      async (_s: string, _i: string, q: { offset?: number }) =>
        (q.offset === 10 ? pages[1] : pages[0]) as RawPage,
    );
    setApiClientForTests(fakeApi({ sessionsRaw }));
    const { result } = renderHook(() => useSessionRaw('claude', 's-basic', 'ag1'), {
      wrapper: wrapperFor(makeQueryClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(result.current.data?.pages).toHaveLength(2);
    expect(result.current.hasNextPage).toBe(false);
    expect(sessionsRaw).toHaveBeenLastCalledWith('claude', 's-basic', {
      agentId: 'ag1',
      offset: 10,
      limit: 200,
    });
  });

  it('usePlans waits for two characters', async () => {
    const plansList = vi.fn(async () => []);
    setApiClientForTests(fakeApi({ plansList }));
    const { result, rerender } = renderHook(({ q }) => usePlans(q), {
      wrapper: wrapperFor(makeQueryClient()),
      initialProps: { q: 'a' },
    });
    expect(result.current.fetchStatus).toBe('idle');
    rerender({ q: 'sa' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(plansList).toHaveBeenCalledWith('sa', 10);
  });
});

describe('applyP3LiveEvent', () => {
  it('invalidates derived session queries and audit lists', async () => {
    const qc = makeQueryClient();
    qc.setQueryData(['session', 'claude', 's1'], { id: 's1' });
    qc.setQueryData(detailKeys.stats('claude', 's1'), stats);
    qc.setQueryData(['audit', {}], []);
    const session = { id: 's1', source: 'claude' } as Session;
    applyP3LiveEvent(qc, { type: 'session.updated', session });
    expect(qc.getQueryState(detailKeys.stats('claude', 's1'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['session', 'claude', 's1'])?.isInvalidated).toBe(false);
    applyP3LiveEvent(qc, {
      type: 'audit.recorded',
      entry: {
        id: 'a',
        ts: 't',
        actor: 'user',
        actorDetail: null,
        action: 'session.resume',
        target: null,
        params: {},
        result: 'ok',
        error: null,
      },
    });
    expect(qc.getQueryState(['audit', {}])?.isInvalidated).toBe(true);
  });
});

describe('useViewModeStore', () => {
  it('defaults to normal and switches', () => {
    expect(useViewModeStore.getState().mode).toBe('normal');
    act(() => useViewModeStore.getState().setMode('verbose'));
    expect(useViewModeStore.getState().mode).toBe('verbose');
  });
});
