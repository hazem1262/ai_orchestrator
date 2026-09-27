import type { Goal } from '@orc/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, makeQueryClient, wrapperFor } from '../../test/p3-render.tsx';
import { setApiClientForTests } from '../client.ts';
import { errorMessage, useGoal, useRunRecap, useSessionRecap, useSetGoal, workKeys } from './work.ts';

const goal: Goal = {
  id: 'g1',
  targetType: 'session',
  targetId: 'claude:s1',
  objective: 'ship',
  state: 'active',
  blockedReason: null,
  updatedAt: 't',
};

describe('work queries', () => {
  it('refreshes the recap and the session after running one', async () => {
    const recapsGetSession = vi.fn(async () => null);
    const recapsRunSession = vi.fn(async () => ({
      text: 'Recap',
      costUsd: 0.2,
      model: 'claude-sonnet-5',
      cached: false,
    }));
    setApiClientForTests(fakeApi({ recapsGetSession, recapsRunSession }));
    const client = makeQueryClient();
    const { result } = renderHook(
      () => ({ q: useSessionRecap('claude', 's1'), m: useRunRecap('claude', 's1') }),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.q.isSuccess).toBe(true));
    await act(async () => {
      await result.current.m.mutateAsync({ onDemand: true });
    });
    expect(recapsRunSession).toHaveBeenCalledWith('claude', 's1', true);
    await waitFor(() => expect(recapsGetSession).toHaveBeenCalledTimes(2));
  });

  it('writes the saved goal straight into its cache', async () => {
    const goalsGet = vi.fn(async () => ({ goal: null, prefill: 'do it' }));
    const goalsSet = vi.fn(async () => goal);
    setApiClientForTests(fakeApi({ goalsGet, goalsSet }));
    const client = makeQueryClient();
    const { result } = renderHook(
      () => ({ q: useGoal('session', 'claude:s1'), m: useSetGoal('session', 'claude:s1') }),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.q.data?.prefill).toBe('do it'));
    await act(async () => {
      await result.current.m.mutateAsync({ objective: 'ship', state: 'active', blockedReason: null });
    });
    expect(client.getQueryData(workKeys.goal('session', 'claude:s1'))).toEqual({ goal, prefill: 'do it' });
  });

  it('maps API error codes to copy', () => {
    expect(errorMessage({ code: 'recaps_disabled' })).toMatch(/turn them on in Settings/);
    expect(errorMessage({ code: 'too_small' })).toMatch(/too few prompts/);
    expect(errorMessage({ code: 'over_budget' })).toMatch(/budget is used up/);
    expect(errorMessage({ code: 'engine_unavailable' })).toMatch(/not available/);
    expect(errorMessage(new Error('boom'))).toBe('Could not generate the recap.');
  });
});
