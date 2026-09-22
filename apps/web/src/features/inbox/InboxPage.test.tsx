import type { InboxItem } from '@orc/core';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { useLaunchStore } from '../../stores/launch.ts';
import { useProjectStore } from '../../stores/project.ts';
import { useTerminalStore } from '../../stores/terminals.ts';
import { inboxItemFixture, liveSessionFixture } from '../../test/factories.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { InboxCount } from './InboxCount.tsx';
import { InboxPage } from './InboxPage.tsx';
import { snoozePresets } from './snooze.ts';

const NOW = new Date(2026, 8, 2, 14, 0, 0); // Wed 2 Sep 2026 14:00 local

const openItems: InboxItem[] = [
  inboxItemFixture({
    id: 'a',
    reason: 'Alpha: waiting — input needed',
    payload: { source: 'claude', id: 's1' },
    ticket: 'SAF-1787',
  }),
  inboxItemFixture({
    id: 'b',
    kind: 'review',
    reason: 'Bravo: ready for review',
    dedupeKey: 'review:claude:s2',
    payload: { source: 'claude', id: 's2' },
  }),
];

const byId = (id: string) => openItems.find((i) => i.id === id) ?? inboxItemFixture({ id });

const inboxList = vi.fn(async (f?: { state?: string[] }) =>
  f?.state?.includes('done') ? [inboxItemFixture({ id: 'z', state: 'done', reason: 'Old' })] : openItems,
);
const inboxDone = vi.fn(async (id: string) => ({ ...byId(id), state: 'done' as const }));
const inboxSnooze = vi.fn(async (id: string, until: string) => ({
  ...byId(id),
  state: 'snoozed' as const,
  snoozeUntil: until,
}));
const inboxReopen = vi.fn(async (id: string) => inboxItemFixture({ id }));

const api = () =>
  createFakeApi({
    inboxList,
    inboxDone,
    inboxSnooze,
    inboxReopen,
    liveList: vi.fn(async () => [
      liveSessionFixture({ id: 's1' }, { ownership: 'owned', ptyId: 'pty-7', status: 'waiting' }),
    ]),
  });

beforeEach(() => {
  for (const f of [inboxList, inboxDone, inboxSnooze, inboxReopen]) f.mockClear();
  useProjectStore.setState({ projectId: 'all' });
  useLaunchStore.setState({ open: false, preset: null });
  useTerminalStore.setState({ tabs: [], active: null });
});

afterEach(() => {
  cleanup();
  setApiClientForTests(null);
});

const rows = () => screen.getAllByRole('listitem');
const selectedReason = () =>
  rows()
    .find((r) => r.getAttribute('aria-current') === 'true')
    ?.querySelector('[data-reason]')?.textContent;

describe('snoozePresets', () => {
  it('offers 1 hour, tomorrow 9:00 and next Monday 9:00', () => {
    expect(snoozePresets(NOW).map((p) => [p.label, p.until])).toEqual([
      ['1 hour', new Date(2026, 8, 2, 15, 0, 0).toISOString()],
      ['Tomorrow 9:00', new Date(2026, 8, 3, 9, 0, 0).toISOString()],
      ['Next Monday 9:00', new Date(2026, 8, 7, 9, 0, 0).toISOString()],
    ]);
  });
});

describe('InboxPage', () => {
  it('lists open items with details and triages with j/k/e/s', async () => {
    renderWithProviders(<InboxPage now={() => NOW.getTime()} />, { api: api() });
    await screen.findByText('Alpha: waiting — input needed');
    expect(within(rows()[0] as HTMLElement).getByText('Waiting')).toBeTruthy();
    expect(within(rows()[0] as HTMLElement).getByText('SAF-1787')).toBeTruthy();
    expect(selectedReason()).toBe('Alpha: waiting — input needed');
    fireEvent.keyDown(window, { key: 'j' });
    expect(selectedReason()).toBe('Bravo: ready for review');
    fireEvent.keyDown(window, { key: 'j' });
    expect(selectedReason()).toBe('Bravo: ready for review');
    fireEvent.keyDown(window, { key: 'k' });
    fireEvent.keyDown(window, { key: 'e' });
    await vi.waitFor(() => expect(inboxDone).toHaveBeenCalledWith('a'));
    await vi.waitFor(() => expect(screen.queryByText('Alpha: waiting — input needed')).toBeNull());
    fireEvent.keyDown(window, { key: 's' });
    await vi.waitFor(() =>
      expect(inboxSnooze).toHaveBeenCalledWith('b', new Date(2026, 8, 2, 15, 0, 0).toISOString()),
    );
  });

  it('ignores keys while typing, with modifiers, or while the launch dialog is open', async () => {
    renderWithProviders(
      <>
        <input aria-label="search" />
        <InboxPage now={() => NOW.getTime()} />
      </>,
      { api: api() },
    );
    await screen.findByText('Alpha: waiting — input needed');
    fireEvent.keyDown(screen.getByLabelText('search'), { key: 'e' });
    fireEvent.keyDown(window, { key: 'e', metaKey: true });
    useLaunchStore.setState({ open: true });
    fireEvent.keyDown(window, { key: 'e' });
    expect(inboxDone).not.toHaveBeenCalled();
  });

  it('opens the session with Enter and the terminal for owned sessions', async () => {
    const openTerminal = vi.fn();
    useTerminalStore.setState({ open: openTerminal });
    const { router } = renderWithProviders(<InboxPage now={() => NOW.getTime()} />, { api: api() });
    await screen.findByText('Alpha: waiting — input needed');
    fireEvent.click(await within(rows()[0] as HTMLElement).findByRole('button', { name: 'Terminal' }));
    expect(openTerminal).toHaveBeenCalledWith('pty-7', 'Alpha: waiting — input needed');
    expect(within(rows()[1] as HTMLElement).queryByRole('button', { name: 'Terminal' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Enter' });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/sessions/claude/s1'));
  });

  it('shows done items with Reopen', async () => {
    renderWithProviders(<InboxPage now={() => NOW.getTime()} />, { api: api() });
    await screen.findByText('Alpha: waiting — input needed');
    fireEvent.click(screen.getByRole('tab', { name: 'Done' }));
    await screen.findByText('Old');
    expect(inboxList).toHaveBeenLastCalledWith({
      state: ['done', 'auto_resolved'],
      projectId: undefined,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await vi.waitFor(() => expect(inboxReopen).toHaveBeenCalledWith('z'));
  });

  it('scopes the list to the selected project', async () => {
    useProjectStore.setState({ projectId: 'wakecap' });
    renderWithProviders(<InboxPage now={() => NOW.getTime()} />, { api: api() });
    await screen.findByText('Alpha: waiting — input needed');
    expect(inboxList).toHaveBeenLastCalledWith({ state: ['open'], projectId: 'wakecap' });
  });
});

describe('InboxCount', () => {
  it('links to the inbox with the open count', async () => {
    renderWithProviders(<InboxCount count={3} />, { api: api() });
    const link = await screen.findByRole('link', { name: 'Inbox, 3 open' });
    expect(link.getAttribute('href')).toBe('/inbox');
    expect(within(link).getByText('3')).toBeTruthy();
  });
});
