import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { useLiveLayoutStore } from '../../stores/live-layout.ts';
import { useProjectStore } from '../../stores/project.ts';
import { liveSessionFixture } from '../../test/factories.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { LiveBoard } from './LiveBoard.tsx';

const sessions = [
  liveSessionFixture({ id: 'a', name: 'Alpha' }, { status: 'busy' }),
  liveSessionFixture({ id: 'b', name: 'Bravo' }, { status: 'waiting' }),
  liveSessionFixture({ id: 'c', name: 'Charlie' }, { status: 'review' }),
  liveSessionFixture({ id: 'd', name: 'Delta', projectId: 'forza' }, { status: 'idle' }),
];

const api = (list = sessions) => createFakeApi({ liveList: vi.fn(async () => list) });

beforeEach(() => {
  useLiveLayoutStore.setState({ layout: 'grid', pinned: [], groupBy: 'none', openInByProject: {} });
  useProjectStore.setState({ projectId: 'all' });
});

afterEach(() => setApiClientForTests(null));

const names = () => screen.getAllByRole('article').map((a) => a.getAttribute('aria-label')?.split(' — ')[0]);

describe('LiveBoard', () => {
  it('lists live sessions attention-first and respects the project scope', async () => {
    renderWithProviders(<LiveBoard now={() => Date.parse('2026-09-01T09:10:00.000Z')} />, {
      api: api(),
    });
    await screen.findByRole('article', { name: /Bravo/ });
    expect(names()).toEqual(['Bravo', 'Charlie', 'Alpha', 'Delta']);
    cleanup();
    useProjectStore.setState({ projectId: 'wakecap' });
    renderWithProviders(<LiveBoard />, { api: api() });
    await screen.findByRole('article', { name: /Bravo/ });
    expect(names()).toEqual(['Bravo', 'Charlie', 'Alpha']);
  });

  it('groups by project', async () => {
    renderWithProviders(<LiveBoard />, { api: api() });
    await screen.findByRole('article', { name: /Bravo/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Group by' }), {
      target: { value: 'project' },
    });
    const groups = screen.getAllByRole('region');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['wakecap', 'forza']);
    expect(within(groups[1] as HTMLElement).getAllByRole('article')).toHaveLength(1);
  });

  it('switches to the compact list layout', async () => {
    renderWithProviders(<LiveBoard />, { api: api() });
    await screen.findByRole('article', { name: /Bravo/ });
    expect(screen.getAllByRole('list', { name: 'Stage' })).toHaveLength(4);
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(names()).toEqual(['Bravo', 'Charlie', 'Alpha', 'Delta']);
    expect(screen.queryByRole('list', { name: 'Stage' })).toBeNull();
  });

  it('shows pinned sessions side by side in split layout', async () => {
    renderWithProviders(<LiveBoard />, { api: api() });
    await screen.findByRole('article', { name: /Bravo/ });
    fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
    expect(screen.getByText('Pin 2–4 sessions to compare them side by side.')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Grid' }));
    fireEvent.click(
      within(screen.getByRole('article', { name: /Bravo/ })).getByRole('button', { name: 'Pin' }),
    );
    fireEvent.click(
      within(screen.getByRole('article', { name: /Alpha/ })).getByRole('button', { name: 'Pin' }),
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
    const split = screen.getByRole('region', { name: 'Split view' });
    expect(split.dataset.columns).toBe('2');
    expect(
      within(split)
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-label')?.split(' — ')[0]),
    ).toEqual(['Bravo', 'Alpha']);
  });

  it('shows an empty state', async () => {
    renderWithProviders(<LiveBoard />, { api: api([]) });
    expect(await screen.findByText('No live sessions right now.')).toBeTruthy();
  });
});
