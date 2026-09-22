import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { inboxTitle, useInboxTitle } from './useInboxTitle.ts';

afterEach(() => {
  document.title = '';
});

describe('inboxTitle', () => {
  it('prefixes the open attention count', () => {
    expect(inboxTitle(0)).toBe('Orchestrator');
    expect(inboxTitle(1)).toBe('(1) Orchestrator');
    expect(inboxTitle(3)).toBe('(3) Orchestrator');
  });
});

describe('useInboxTitle', () => {
  it('keeps document.title in step with the count', () => {
    const { rerender } = renderHook(({ n }) => useInboxTitle(n), { initialProps: { n: 2 } });
    expect(document.title).toBe('(2) Orchestrator');
    rerender({ n: 0 });
    expect(document.title).toBe('Orchestrator');
  });
});
