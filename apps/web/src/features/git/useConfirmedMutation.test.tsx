import { ApiRequestError } from '@orc/api-contract';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeQueryClient, wrapperFor } from '@/test/p3-render.tsx';
import { useConfirmedMutation } from './useConfirmedMutation.ts';

const wrapper = wrapperFor(makeQueryClient());

describe('useConfirmedMutation', () => {
  it('turns a 409 confirmation_required into a pending request, then retries with confirm', async () => {
    const fn = vi.fn(async (vars: { path: string; confirmExternal?: boolean }, confirm: boolean) => {
      if (!confirm)
        throw new ApiRequestError(409, 'confirmation_required', 'x', {
          summary: 'Remove worktree /w',
          external: true,
        });
      return { ok: true, vars };
    });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useConfirmedMutation(fn, { onSuccess }), { wrapper });
    await act(() => result.current.run({ path: '/w' }));
    expect(result.current.pending).toEqual({
      summary: 'Remove worktree /w',
      details: { summary: 'Remove worktree /w', external: true },
      vars: { path: '/w' },
    });
    await act(() => result.current.confirm({ confirmExternal: true }));
    await waitFor(() =>
      expect(result.current.data).toEqual({ ok: true, vars: { path: '/w', confirmExternal: true } }),
    );
    expect(fn).toHaveBeenLastCalledWith({ path: '/w', confirmExternal: true }, true);
    expect(result.current.pending).toBeNull();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('surfaces other errors and supports cancel', async () => {
    const fn = vi.fn(async (_v: number, confirm: boolean) => {
      if (!confirm) throw new ApiRequestError(409, 'confirmation_required', 'x', { summary: 's' });
      throw new ApiRequestError(409, 'dirty_worktree', 'uncommitted changes');
    });
    const { result } = renderHook(() => useConfirmedMutation(fn), { wrapper });
    await act(() => result.current.run(1));
    act(() => result.current.cancel());
    expect(result.current.pending).toBeNull();
    await act(() => result.current.run(1));
    await act(() => result.current.confirm());
    expect((result.current.error as ApiRequestError).code).toBe('dirty_worktree');
  });
});
