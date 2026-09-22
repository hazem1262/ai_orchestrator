import type { InboxItem } from '@orc/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inboxItemFixture } from '../../test/factories.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { makeQueryClient, queryWrapper } from '../../test/query.tsx';
import { setApiClientForTests } from '../client.ts';
import {
  inboxKey,
  matchesInboxFilter,
  scopeProject,
  upsertInboxItemInCache,
  useInbox,
  useInboxAction,
  useOpenInboxCount,
} from './inbox.ts';

afterEach(() => setApiClientForTests(null));

describe('inbox helpers', () => {
  it('scopes the project: null and the "all" sentinel mean no project filter', () => {
    expect(scopeProject(null)).toBeUndefined();
    expect(scopeProject(undefined)).toBeUndefined();
    expect(scopeProject('all')).toBeUndefined();
    expect(scopeProject('wakecap')).toBe('wakecap');
  });

  it('matches items against state, kind and project filters', () => {
    const item = inboxItemFixture();
    expect(matchesInboxFilter(item, {})).toBe(true);
    expect(matchesInboxFilter(item, { state: ['done'] })).toBe(false);
    expect(matchesInboxFilter(item, { state: ['open', 'snoozed'] })).toBe(true);
    expect(matchesInboxFilter(item, { kind: ['waiting', 'review'], projectId: 'wakecap' })).toBe(true);
    expect(matchesInboxFilter(item, { kind: ['error'] })).toBe(false);
    expect(matchesInboxFilter(item, { projectId: 'forza' })).toBe(false);
  });

  it('keys the cache by filters', () => {
    expect(inboxKey({ state: ['open'] })).toEqual(['inbox', { state: ['open'] }]);
  });

  it('upserts into every cached inbox list and skips uncached ones', () => {
    const qc = makeQueryClient();
    qc.setQueryData(inboxKey({ state: ['open'] }), [inboxItemFixture({ id: 'a' })]);
    upsertInboxItemInCache(qc, inboxItemFixture({ id: 'a', state: 'snoozed' }));
    expect(qc.getQueryData(inboxKey({ state: ['open'] }))).toEqual([]);
    expect(qc.getQueryData(inboxKey({ state: ['snoozed'] }))).toBeUndefined();
  });
});

describe('inbox queries', () => {
  it('useInbox fetches GET /api/inbox with the filters', async () => {
    const items = [inboxItemFixture({ id: 'a' }), inboxItemFixture({ id: 'b' })];
    const inboxList = vi.fn(async () => items);
    setApiClientForTests(createFakeApi({ inboxList }));
    const qc = makeQueryClient();
    const { result } = renderHook(() => useInbox({ state: ['open'], kind: ['waiting'] }), {
      wrapper: queryWrapper(qc),
    });
    await waitFor(() => expect(result.current.data?.map((i) => i.id)).toEqual(['a', 'b']));
    expect(inboxList).toHaveBeenCalledWith({ state: ['open'], kind: ['waiting'] });
  });

  it('counts open items for the project and drops an item after "done"', async () => {
    const done: InboxItem = inboxItemFixture({ state: 'done', updatedAt: '2026-09-01T09:05:00.000Z' });
    const inboxList = vi.fn(async () => [inboxItemFixture()]);
    const inboxDone = vi.fn(async () => done);
    setApiClientForTests(createFakeApi({ inboxList, inboxDone }));
    const qc = makeQueryClient();
    const wrapper = queryWrapper(qc);
    const count = renderHook(() => useOpenInboxCount('wakecap'), { wrapper });
    await waitFor(() => expect(count.result.current).toBe(1));
    expect(inboxList).toHaveBeenCalledWith({ state: ['open'], projectId: 'wakecap' });
    const action = renderHook(() => useInboxAction(), { wrapper });
    await act(() => action.result.current.mutateAsync({ id: 'i1', action: 'done' }));
    expect(inboxDone).toHaveBeenCalledWith('i1');
    expect(qc.getQueryData(inboxKey({ state: ['open'], projectId: 'wakecap' }))).toEqual([]);
    await waitFor(() => expect(count.result.current).toBe(0));
  });

  it('counts across all projects when no project is given', async () => {
    const inboxList = vi.fn(async () => [
      inboxItemFixture({ id: 'a' }),
      inboxItemFixture({ id: 'b', projectId: 'forza' }),
    ]);
    setApiClientForTests(createFakeApi({ inboxList }));
    const { result } = renderHook(() => useOpenInboxCount(), { wrapper: queryWrapper(makeQueryClient()) });
    await waitFor(() => expect(result.current).toBe(2));
    expect(inboxList).toHaveBeenCalledWith({ state: ['open'] });
  });

  it('routes snooze and reopen to their client methods', async () => {
    const inboxSnooze = vi.fn(async (id: string, until: string) =>
      inboxItemFixture({ id, state: 'snoozed', snoozeUntil: until }),
    );
    const inboxReopen = vi.fn(async (id: string) => inboxItemFixture({ id }));
    setApiClientForTests(createFakeApi({ inboxSnooze, inboxReopen }));
    const qc = makeQueryClient();
    qc.setQueryData(inboxKey({ state: ['snoozed'] }), []);
    const { result } = renderHook(() => useInboxAction(), { wrapper: queryWrapper(qc) });
    await act(() =>
      result.current.mutateAsync({ id: 'i1', action: 'snooze', until: '2026-09-02T09:00:00.000Z' }),
    );
    expect(inboxSnooze).toHaveBeenCalledWith('i1', '2026-09-02T09:00:00.000Z');
    expect(qc.getQueryData<InboxItem[]>(inboxKey({ state: ['snoozed'] }))?.map((i) => i.id)).toEqual(['i1']);
    await act(() => result.current.mutateAsync({ id: 'i1', action: 'reopen' }));
    expect(inboxReopen).toHaveBeenCalledWith('i1');
    expect(qc.getQueryData(inboxKey({ state: ['snoozed'] }))).toEqual([]);
  });
});
