import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useReviewDraft } from './useReviewDraft.ts';

beforeEach(() => localStorage.clear());

describe('useReviewDraft', () => {
  it('adds, removes and persists comments and viewed files', () => {
    const { result, unmount } = renderHook(() => useReviewDraft('claude:s1'));
    act(() => result.current.add({ file: 'a.ts', line: 3, side: 'new', body: 'x' }));
    act(() => result.current.add({ file: 'b.ts', line: 1, side: 'old', body: 'y' }));
    act(() => result.current.toggleViewed('a.ts'));
    act(() => result.current.remove(0));
    unmount();
    const again = renderHook(() => useReviewDraft('claude:s1')).result;
    expect(again.current.comments).toEqual([{ file: 'b.ts', line: 1, side: 'old', body: 'y' }]);
    expect(again.current.viewed).toEqual(['a.ts']);
    act(() => again.current.toggleViewed('a.ts'));
    act(() => again.current.clear());
    expect(again.current.comments).toEqual([]);
    expect(again.current.viewed).toEqual([]);
  });
});
