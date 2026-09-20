import { describe, expect, it } from 'vitest';
import {
  cleanSearch,
  parseHistorySearch,
  searchToViewQuery,
  toListFilters,
  viewQueryToSearch,
} from './filters.ts';

describe('history search params', () => {
  it('parses router search values defensively', () => {
    expect(
      parseHistorySearch({
        q: 1787,
        source: 'codex',
        ticket: 'SAF-1',
        minCost: '0.5',
        maxCost: 3,
        touchedProd: 'true',
        pinned: true,
        hasSubagents: 'nope',
        availability: 'prompts-only',
        model: '',
        bogus: 'x',
      }),
    ).toEqual({
      q: '1787',
      source: 'codex',
      ticket: 'SAF-1',
      minCost: 0.5,
      maxCost: 3,
      touchedProd: true,
      pinned: true,
      availability: 'prompts-only',
    });
    expect(parseHistorySearch({ source: 'cursor', availability: 'gone', minCost: 'abc' })).toEqual({});
  });

  it('builds list filters for a project or all projects', () => {
    expect(toListFilters({ q: 'x' }, 'wakecap')).toEqual({ q: 'x', projectId: 'wakecap', limit: 50 });
    expect(toListFilters({ q: 'x' }, 'all')).toEqual({ q: 'x', projectId: undefined, limit: 50 });
    expect(toListFilters({ from: '2026-09-01', to: '2026-09-02' }, 'all')).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-02T23:59:59.999Z',
    });
  });

  it('round-trips saved view queries and cleans empties', () => {
    const search = { q: 'weekend', touchedProd: true, minCost: 1 };
    expect(searchToViewQuery(search)).toEqual({ q: 'weekend', touchedProd: 'true', minCost: '1' });
    expect(viewQueryToSearch(searchToViewQuery(search))).toEqual(search);
    expect(cleanSearch({ q: '', ticket: undefined, pinned: false, touchedProd: true })).toEqual({
      touchedProd: true,
    });
  });
});
