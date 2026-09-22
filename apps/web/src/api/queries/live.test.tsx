import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveSessionFixture } from '../../test/factories.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { makeQueryClient, queryWrapper } from '../../test/query.tsx';
import { setApiClientForTests } from '../client.ts';
import { liveKey, useLive } from './live.ts';

afterEach(() => setApiClientForTests(null));

describe('useLive', () => {
  it('fetches GET /api/live into the ["live"] cache', async () => {
    const liveList = vi.fn(async () => [liveSessionFixture({ id: 'a' }), liveSessionFixture({ id: 'b' })]);
    setApiClientForTests(createFakeApi({ liveList }));
    const qc = makeQueryClient();
    const { result } = renderHook(() => useLive(), { wrapper: queryWrapper(qc) });
    await waitFor(() => expect(result.current.data?.map((s) => s.id)).toEqual(['a', 'b']));
    expect(liveList).toHaveBeenCalledTimes(1);
    expect(liveKey).toEqual(['live']);
    expect(qc.getQueryData(liveKey)).toBe(result.current.data);
  });
});
