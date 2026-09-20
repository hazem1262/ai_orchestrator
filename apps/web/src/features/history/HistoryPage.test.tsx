import type { SessionListFilters } from '@orc/api-contract';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../stores/project.ts';
import { listItemFixture } from '../../test/factories.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import type { HistorySearch } from './filters.ts';
import { HistoryPage } from './HistoryPage.tsx';

function Harness({ initial = {} }: { initial?: HistorySearch }) {
  const [search, setSearch] = useState<HistorySearch>(initial);
  return (
    <>
      <output data-testid="search">{JSON.stringify(search)}</output>
      <HistoryPage search={search} onSearchChange={setSearch} />
    </>
  );
}

const currentSearch = () => JSON.parse(screen.getByTestId('search').textContent ?? '{}') as HistorySearch;

const items = [
  listItemFixture({
    id: 's-basic',
    name: 'Notification service test check',
    snippet: 'check the ⟦notification⟧ service',
    tickets: ['SAF-1787'],
    prs: [{ repo: 'o/r', number: 231, url: 'https://github.com/o/r/pull/231' }],
    labels: ['later'],
  }),
  listItemFixture({
    id: 's-old',
    name: 'old session from december',
    availability: 'prompts-only',
    costUsd: null,
  }),
];

describe('HistoryPage', () => {
  beforeEach(() => useProjectStore.setState({ projectId: 'wakecap' }));

  it('renders rows with links, snippets and chips', async () => {
    const api = createFakeApi({ sessionsList: vi.fn(async () => ({ items, nextCursor: null })) });
    renderWithProviders(<Harness />, { api });
    const link = await screen.findByRole('link', { name: 'Notification service test check' });
    expect(link.getAttribute('href')).toBe('/sessions/claude/s-basic');
    const row = link.closest('tr');
    if (!row) throw new Error('row missing');
    const r = within(row);
    expect(r.getByText('notification').tagName).toBe('MARK');
    expect(r.getByText('SAF-1787')).toBeTruthy();
    expect(r.getByRole('link', { name: '#231' })).toBeTruthy();
    expect(r.getByText('later')).toBeTruthy();
    expect(r.getByText('$0.42')).toBeTruthy();
    expect(r.getByText('7m')).toBeTruthy();
    expect(screen.getByText('prompts-only')).toBeTruthy();
    expect(api.sessionsList).toHaveBeenCalledWith({ projectId: 'wakecap', limit: 50 });
  });

  it('debounces search and applies filters to the query', async () => {
    const sessionsList = vi.fn(async (_f: SessionListFilters) => ({ items, nextCursor: null }));
    renderWithProviders(<Harness />, { api: createFakeApi({ sessionsList }) });
    await screen.findByRole('link', { name: 'Notification service test check' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search sessions' }), 'weekend');
    await waitFor(() => expect(currentSearch()).toEqual({ q: 'weekend' }));
    await waitFor(() =>
      expect(sessionsList).toHaveBeenLastCalledWith({ q: 'weekend', projectId: 'wakecap', limit: 50 }),
    );

    await userEvent.click(screen.getByRole('checkbox', { name: 'Touched prod' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Source' }), 'codex');
    await waitFor(() =>
      expect(currentSearch()).toEqual({ q: 'weekend', touchedProd: true, source: 'codex' }),
    );
    await waitFor(() =>
      expect(sessionsList).toHaveBeenLastCalledWith({
        q: 'weekend',
        touchedProd: true,
        source: 'codex',
        projectId: 'wakecap',
        limit: 50,
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(currentSearch()).toEqual({});
    expect((screen.getByRole('searchbox', { name: 'Search sessions' }) as HTMLInputElement).value).toBe('');
  });

  it('queries all projects when "All projects" is selected', async () => {
    useProjectStore.setState({ projectId: 'all' });
    const sessionsList = vi.fn(async () => ({ items: [], nextCursor: null }));
    renderWithProviders(<Harness />, { api: createFakeApi({ sessionsList }) });
    expect(await screen.findByText('No sessions match these filters.')).toBeTruthy();
    expect(sessionsList).toHaveBeenCalledWith({ projectId: undefined, limit: 50 });
  });

  it('loads the next page when scrolled to the end', async () => {
    const sessionsList = vi.fn(async (f: SessionListFilters) =>
      f.cursor
        ? { items: [listItemFixture({ id: 'page-2' })], nextCursor: null }
        : { items, nextCursor: 'c1' },
    );
    renderWithProviders(<Harness />, { api: createFakeApi({ sessionsList }) });
    expect(await screen.findByRole('link', { name: 'Session page-2' })).toBeTruthy();
    expect(sessionsList).toHaveBeenLastCalledWith({ projectId: 'wakecap', limit: 50, cursor: 'c1' });
  });

  it('pins, labels and hides rows', async () => {
    const api = createFakeApi({ sessionsList: vi.fn(async () => ({ items, nextCursor: null })) });
    renderWithProviders(<Harness />, { api });
    const link = await screen.findByRole('link', { name: 'Notification service test check' });
    const row = within(link.closest('tr') as HTMLElement);
    await userEvent.click(row.getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(api.sessionsPin).toHaveBeenCalledWith('claude', 's-basic', true));

    await userEvent.click(row.getByRole('button', { name: 'Labels' }));
    const input = row.getByRole('textbox', { name: 'Labels' });
    await userEvent.clear(input);
    await userEvent.type(input, 'bug, later{Enter}');
    await waitFor(() =>
      expect(api.sessionsLabel).toHaveBeenCalledWith('claude', 's-basic', ['bug', 'later']),
    );

    await userEvent.click(row.getByRole('button', { name: 'Hide' }));
    await waitFor(() =>
      expect(api.sessionsLabel).toHaveBeenLastCalledWith('claude', 's-basic', ['later', 'hidden']),
    );
  });

  it('applies, saves and deletes saved views', async () => {
    const viewsSave = vi.fn(async (b: { name: string; query: Record<string, string> }) => ({
      id: 'v2',
      name: b.name,
      query: b.query,
      createdAt: 'now',
    }));
    const api = createFakeApi({
      sessionsList: vi.fn(async () => ({ items, nextCursor: null })),
      viewsList: vi.fn(async () => [
        { id: 'v1', name: 'Prod', query: { touchedProd: 'true' }, createdAt: 'now' },
      ]),
      viewsSave,
    });
    renderWithProviders(<Harness initial={{ q: 'weekend' }} />, { api });
    await userEvent.click(await screen.findByRole('button', { name: 'Prod' }));
    expect(currentSearch()).toEqual({ touchedProd: true });

    await userEvent.type(screen.getByRole('textbox', { name: 'View name' }), 'Prod sessions');
    await userEvent.click(screen.getByRole('button', { name: 'Save view' }));
    await waitFor(() =>
      expect(viewsSave).toHaveBeenCalledWith({ name: 'Prod sessions', query: { touchedProd: 'true' } }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Delete view Prod' }));
    await waitFor(() => expect(api.viewsDelete).toHaveBeenCalledWith('v1'));
  });
});
