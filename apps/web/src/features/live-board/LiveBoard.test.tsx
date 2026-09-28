import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/** Opens a Radix menu from the keyboard. Radix opens it on pointerdown, and user-event drops that
 *  pointerdown when an earlier test in the file left its pointer state behind. */
async function openMenu(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
  trigger.focus();
  await user.keyboard('{Enter}');
}

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
    const user = userEvent.setup();
    renderWithProviders(<LiveBoard />, { api: api() });
    await screen.findByRole('article', { name: /Bravo/ });
    await openMenu(user, screen.getByRole('button', { name: 'No grouping' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Group by project' }));
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
    const user = userEvent.setup();
    renderWithProviders(<LiveBoard />, { api: api() });
    await screen.findByRole('article', { name: /Bravo/ });
    fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
    expect(screen.getByText('Pin 2–4 sessions to compare them side by side.')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Grid' }));
    for (const name of ['Bravo', 'Alpha']) {
      await openMenu(user, screen.getByRole('button', { name: `More actions for ${name}` }));
      await user.click(await screen.findByRole('menuitem', { name: 'Pin to split' }));
    }
    fireEvent.click(screen.getByRole('radio', { name: 'Split' }));
    const split = screen.getByRole('region', { name: 'Split view' });
    expect(split.dataset.columns).toBe('2');
    expect(
      within(split)
        .getAllByRole('article')
        .map((a) => a.getAttribute('aria-label')?.split(' — ')[0]),
    ).toEqual(['Bravo', 'Alpha']);
  });

  it('filters to the sessions that need you or are running, with counts', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LiveBoard />, { api: api() });
    await screen.findByRole('article', { name: /Bravo/ });
    const filters = screen.getByRole('radiogroup', { name: 'Filter sessions' });
    expect(within(filters).getByRole('radio', { name: 'All 4' }).getAttribute('aria-checked')).toBe('true');
    await user.click(within(filters).getByRole('radio', { name: 'Needs you 2' }));
    expect(names()).toEqual(['Bravo', 'Charlie']);
    await user.click(within(filters).getByRole('radio', { name: 'Running 1' }));
    expect(names()).toEqual(['Alpha']);
    // Clicking the active filter again keeps it selected rather than clearing it.
    await user.click(within(filters).getByRole('radio', { name: 'Running 1' }));
    expect(names()).toEqual(['Alpha']);
    await user.click(within(filters).getByRole('radio', { name: 'All 4' }));
    expect(names()).toEqual(['Bravo', 'Charlie', 'Alpha', 'Delta']);
  });

  it('offers to show all when a filter matches nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LiveBoard />, {
      api: api([liveSessionFixture({ id: 'i', name: 'Idle one' }, { status: 'idle' })]),
    });
    await screen.findByRole('article', { name: /Idle one/ });
    await user.click(screen.getByRole('radio', { name: 'Running 0' }));
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.getByText('Nothing matches this filter')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(names()).toEqual(['Idle one']);
  });

  it('shows a loading skeleton, then an error with a retry that refetches', async () => {
    const user = userEvent.setup();
    let fail = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const liveList = vi.fn(async () => {
      await gate;
      if (fail) throw new Error('daemon unreachable');
      return sessions;
    });
    renderWithProviders(<LiveBoard />, { api: createFakeApi({ liveList }) });
    expect(screen.getByRole('status', { name: 'Loading live sessions' })).toBeTruthy();
    release();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn't load live sessions")).toBeTruthy();
    expect(within(alert).getByText('daemon unreachable')).toBeTruthy();
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await screen.findByRole('article', { name: /Bravo/ });
    expect(liveList).toHaveBeenCalledTimes(2);
  });

  it('shows an empty state', async () => {
    renderWithProviders(<LiveBoard />, { api: api([]) });
    expect(await screen.findByText('No live sessions right now.')).toBeTruthy();
  });
});
