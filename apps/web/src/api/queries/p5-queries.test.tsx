import type { UsageSnapshot } from '@orc/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, makeQueryClient, wrapperFor } from '../../test/p3-render.tsx';
import { setApiClientForTests } from '../client.ts';
import { applyLiveEvent } from '../live-events.ts';
import { analyticsKeys, rangeFor, useAnalyticsCost, useDigest, useGenerateDigest } from './analytics.ts';
import { usageKeys, useBudgets, useUpsertBudget, useUsage } from './usage.ts';

const snapshot: UsageSnapshot = {
  source: 'estimate',
  generatedAt: '2026-09-18T09:00:00.000Z',
  block: {
    active: true,
    start: '2026-09-18T08:00:00.000Z',
    end: '2026-09-18T13:00:00.000Z',
    tokens: 10,
    costUsd: 2,
    pctOfLimit: 0.2,
  },
  week: { tokens: 100, costUsd: 20, pctOfLimit: null },
  burnRateUsdPerHour: 1,
  burnRateTokensPerMin: 2,
  projectedBlockExhaustionAt: null,
};

describe('usage queries', () => {
  it('fetches the snapshot and applies usage.updated from the WS', async () => {
    const usageGet = vi.fn(async () => snapshot);
    setApiClientForTests(fakeApi({ usageGet }));
    const client = makeQueryClient();
    const { result } = renderHook(() => useUsage(), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.data).toEqual(snapshot));
    const next = { ...snapshot, block: { ...snapshot.block, costUsd: 9 } };
    act(() => applyLiveEvent(client, { type: 'usage.updated', snapshot: next }));
    expect(client.getQueryData(usageKeys.snapshot)).toEqual(next);
  });

  it('invalidates budgets after an upsert', async () => {
    const usageBudgets = vi.fn(async () => []);
    const usageBudgetUpsert = vi.fn(async () => ({
      id: 'b1',
      scopeType: 'ticket' as const,
      scopeId: 'SAF-1',
      period: 'daily' as const,
      limitUsd: 5,
      origin: 'table' as const,
    }));
    setApiClientForTests(fakeApi({ usageBudgets, usageBudgetUpsert }));
    const client = makeQueryClient();
    const { result } = renderHook(() => ({ list: useBudgets(), save: useUpsertBudget() }), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    await act(async () => {
      await result.current.save.mutateAsync({
        scopeType: 'ticket',
        scopeId: 'SAF-1',
        period: 'daily',
        limitUsd: 5,
      });
    });
    expect(usageBudgetUpsert).toHaveBeenCalledWith({
      scopeType: 'ticket',
      scopeId: 'SAF-1',
      period: 'daily',
      limitUsd: 5,
    });
    await waitFor(() => expect(usageBudgets).toHaveBeenCalledTimes(2));
  });
});

describe('analytics queries', () => {
  it('passes params through and keys by them', async () => {
    const analyticsCost = vi.fn(async () => ({ rows: [], estimated: true }));
    setApiClientForTests(fakeApi({ analyticsCost }));
    const client = makeQueryClient();
    const params = { from: 'a', to: 'b', groupBy: 'day' as const };
    const { result } = renderHook(() => useAnalyticsCost(params), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(analyticsCost).toHaveBeenCalledWith({ from: 'a', to: 'b', groupBy: 'day' });
    expect(client.getQueryData(analyticsKeys.cost(params))).toEqual({ rows: [], estimated: true });
  });

  it('computes a range and refreshes the digest after generating one', async () => {
    expect(rangeFor(7, new Date('2026-09-18T09:00:00.000Z'))).toEqual({
      from: '2026-09-11T09:00:00.000Z',
      to: '2026-09-18T09:00:00.000Z',
    });
    const record = { weekStart: '2026-09-07', markdown: '# d', createdAt: 'x' };
    const analyticsDigestLatest = vi.fn(async () => null);
    const analyticsDigestGenerate = vi.fn(async () => record);
    setApiClientForTests(fakeApi({ analyticsDigestLatest, analyticsDigestGenerate }));
    const client = makeQueryClient();
    const { result } = renderHook(() => ({ latest: useDigest(), gen: useGenerateDigest() }), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.latest.isSuccess).toBe(true));
    await act(async () => {
      await result.current.gen.mutateAsync(undefined);
    });
    expect(client.getQueryData(analyticsKeys.digest)).toEqual(record);
  });
});
