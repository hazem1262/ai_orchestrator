import type { InboxItem } from '@orc/core';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { Toaster } from '../../components/ui/sonner.tsx';
import { useProjectStore } from '../../stores/project.ts';
import { inboxItemFixture } from '../../test/factories.ts';
import { createFakeApi, type FakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { InboxPage } from './InboxPage.tsx';
import { groupItems } from './kinds.ts';

const NOW = new Date(2026, 8, 2, 14, 0, 0);

const pr = (id: string, session: string) =>
  inboxItemFixture({
    id,
    kind: 'pr_event',
    reason: 'PR #237 checks failed',
    ticket: 'SAF-9',
    dedupeKey: `pr_event:${id}`,
    payload: { source: 'claude', id: session },
  });

const items: InboxItem[] = [
  pr('p1', 's1'),
  inboxItemFixture({ id: 'w', reason: 'Waiting on input', payload: { source: 'claude', id: 's3' } }),
  pr('p2', 's2'),
];

let state: Record<string, InboxItem>;

function api(extra: Partial<FakeApi> = {}) {
  const set = (id: string, patch: Partial<InboxItem>) => {
    const next = { ...(state[id] as InboxItem), ...patch, updatedAt: new Date().toISOString() };
    state[id] = next;
    return next;
  };
  return createFakeApi({
    inboxList: vi.fn(async (f?: { state?: string[] }) =>
      Object.values(state).filter((i) => !f?.state || f.state.includes(i.state)),
    ),
    inboxDone: vi.fn(async (id: string) => set(id, { state: 'done', snoozeUntil: null })),
    inboxSnooze: vi.fn(async (id: string, until: string) =>
      set(id, { state: 'snoozed', snoozeUntil: until }),
    ),
    inboxReopen: vi.fn(async (id: string) => set(id, { state: 'open', snoozeUntil: null })),
    inboxApprove: vi.fn(async (id: string) => set(id, { state: 'done' })),
    liveList: vi.fn(async () => []),
    ...extra,
  });
}

/** Radix menus open on pointerdown, which jsdom's user-event does not deliver the way Radix reads it. */
async function openMenu(trigger: HTMLElement) {
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  return screen.findByRole('menu');
}

const rows = () => within(screen.getByRole('list', { name: 'Inbox items' })).getAllByRole('listitem');

// jsdom lacks pointer capture, which Radix menus and Sonner's swipe handler call on pointerdown.
for (const m of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'] as const) {
  if (!(m in Element.prototype)) Object.assign(Element.prototype, { [m]: () => false });
}

beforeEach(() => {
  state = Object.fromEntries(items.map((i) => [i.id, i]));
  useProjectStore.setState({ projectId: 'all' });
});

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
  vi.unstubAllGlobals();
  setApiClientForTests(null);
});

describe('groupItems', () => {
  it('collapses items with the same kind, reason and ticket, keeping first-seen order', () => {
    const g = groupItems(items);
    expect(g.map((x) => [x.lead.id, x.items.map((i) => i.id)])).toEqual([
      ['p1', ['p1', 'p2']],
      ['w', ['w']],
    ]);
    expect(groupItems([pr('a', 's1'), { ...pr('b', 's2'), ticket: 'SAF-10' }])).toHaveLength(2);
  });
});

describe('InboxPage triage', () => {
  it('shows duplicates as one row with a count, and Done closes every copy with an Undo', async () => {
    const fake = api();
    renderWithProviders(
      <>
        <Toaster />
        <InboxPage now={() => NOW.getTime()} />
      </>,
      { api: fake },
    );
    await screen.findByText('Waiting on input');
    expect(rows()).toHaveLength(2);
    const prRow = rows()[0] as HTMLElement;
    expect(within(prRow).getByLabelText('2 identical items').textContent).toBe('×2');

    await userEvent.click(within(prRow).getByRole('button', { name: 'Mark done' }));
    await vi.waitFor(() => expect(fake.inboxDone).toHaveBeenCalledTimes(2));
    expect(fake.inboxDone).toHaveBeenCalledWith('p1');
    expect(fake.inboxDone).toHaveBeenCalledWith('p2');
    await vi.waitFor(() => expect(rows()).toHaveLength(1));

    // A plain click: user-event's focus move hands Sonner a relatedTarget jsdom cannot focus.
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await vi.waitFor(() => expect(fake.inboxReopen).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
  });

  it('snoozes from one menu per row, offering every preset', async () => {
    const fake = api();
    renderWithProviders(<InboxPage now={() => NOW.getTime()} />, { api: fake });
    await screen.findByText('Waiting on input');
    expect(screen.queryByRole('combobox', { name: 'Snooze' })).toBeNull();
    const row = rows()[1] as HTMLElement;
    const menu = await openMenu(within(row).getByRole('button', { name: 'Snooze' }));
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['1 hourS', 'Tomorrow 9:00', 'Next Monday 9:00']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Tomorrow 9:00' }));
    await vi.waitFor(() =>
      expect(fake.inboxSnooze).toHaveBeenCalledWith('w', new Date(2026, 8, 3, 9, 0, 0).toISOString()),
    );
  });

  it('offers Approve on desktop through the row menu', async () => {
    const fake = api();
    renderWithProviders(<InboxPage now={() => NOW.getTime()} />, { api: fake });
    await screen.findByText('Waiting on input');
    const menu = await openMenu(
      within(rows()[1] as HTMLElement).getByRole('button', { name: 'More actions' }),
    );
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Approve' }));
    await vi.waitFor(() => expect(fake.inboxApprove).toHaveBeenCalledWith('w'));
  });

  it('expands a plan approval row when it is selected', async () => {
    state.plan = inboxItemFixture({
      id: 'plan',
      kind: 'plan_approval',
      reason: 'Plan ready: tidy the sort',
      sessionId: 'claude:s9',
      dedupeKey: 'plan_approval:s9',
      updatedAt: '2026-08-01T00:00:00.000Z',
      payload: { plan: '1. Move sortLive', owned: true },
    });
    renderWithProviders(<InboxPage now={() => NOW.getTime()} />, { api: api() });
    const reason = await screen.findByText('Plan ready: tidy the sort');
    expect(screen.queryByText('1. Move sortLive')).toBeNull();
    await userEvent.click(reason);
    expect(await screen.findByText('1. Move sortLive')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve plan' })).toBeTruthy();
  });

  it('shows an error with Retry when the list fails to load', async () => {
    let fail = true;
    const inboxList = vi.fn(async () => {
      if (fail) throw new Error('daemon unreachable');
      return items;
    });
    renderWithProviders(<InboxPage now={() => NOW.getTime()} />, { api: api({ inboxList }) });
    expect(await screen.findByText('daemon unreachable')).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Waiting on input')).toBeTruthy();
  });
});

describe('InboxPage at phone width', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
  });

  it('renders cards with Approve, Done, Snooze 1h and the later snooze presets', async () => {
    const fake = api();
    renderWithProviders(<InboxPage now={() => NOW.getTime()} />, { api: fake });
    const card = await screen.findByRole('article', { name: 'Waiting: Waiting on input' });
    expect(within(screen.getByRole('article', { name: /PR #237/ })).getByText('×2')).toBeTruthy();
    const menu = await openMenu(within(card).getByRole('button', { name: 'More snooze options' }));
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['Tomorrow 9:00', 'Next Monday 9:00']);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(card).getByRole('button', { name: 'Snooze 1h' }));
    await vi.waitFor(() =>
      expect(fake.inboxSnooze).toHaveBeenCalledWith('w', new Date(2026, 8, 2, 15, 0, 0).toISOString()),
    );
    const prCard = screen.getByRole('article', { name: /PR #237/ });
    await userEvent.click(within(prCard).getByRole('button', { name: 'Approve' }));
    await vi.waitFor(() => expect(fake.inboxApprove).toHaveBeenCalledWith('p1'));
  });
});
