import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { useLiveLayoutStore } from '../../stores/live-layout.ts';
import { useTerminalStore } from '../../stores/terminals.ts';
import { liveSessionFixture } from '../../test/factories.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { SessionCard } from './SessionCard.tsx';

const NOW = Date.parse('2026-09-01T09:10:00.000Z');
const sessionsKill = vi.fn(async () => ({ killed: 'pty' as const }));
const sessionsOpenIn = vi.fn(async () => ({ ok: true as const }));
const realOpen = useTerminalStore.getState().open;

const api = () => createFakeApi({ sessionsKill, sessionsOpenIn });

beforeEach(() => {
  useLiveLayoutStore.setState({ openInByProject: {} });
  sessionsKill.mockClear();
  sessionsOpenIn.mockClear();
});

afterEach(() => {
  useTerminalStore.setState({ open: realOpen });
  setApiClientForTests(null);
  vi.restoreAllMocks();
});

const full = liveSessionFixture(
  {
    id: 's-live',
    name: 'SLA weekends',
    cwds: ['/Users/test/Wakecap', '/Users/test/Wakecap/Backend/svc'],
    lastPrompt: 'run the tests again',
    tickets: ['SAF-1787'],
    prs: [{ repo: 'example-org/svc', number: 231, url: 'https://github.com/example-org/svc/pull/231' }],
    usage: { input: 15, output: 27, cacheRead: 2100, cacheWrite: 100, costUsd: 1.25 },
    lastTest: { ts: '', command: 'pnpm test', passed: 16, failed: 2, skipped: 0, durationMs: 1400 },
  },
  {
    status: 'waiting',
    waitingFor: 'input needed',
    since: '2026-09-01T09:05:00.000Z',
    ownership: 'owned',
    ptyId: 'pty-1',
    stage: 'test',
    currentTool: 'Bash',
    backgroundJobs: 2,
    runningSubagents: 3,
    contextFill: 0.42,
  },
);

/** Opens a Radix menu from the keyboard. Radix opens it on pointerdown, and user-event drops that
 *  pointerdown when an earlier test in the file left its pointer state behind. */
async function openMenu(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
  trigger.focus();
  await user.keyboard('{Enter}');
}

describe('SessionCard', () => {
  it('shows every F1 field', async () => {
    renderWithProviders(<SessionCard session={full} now={NOW} pinned={false} onTogglePin={() => {}} />, {
      api: api(),
    });
    const card = await screen.findByRole('article', { name: 'SLA weekends — Waiting' });
    const c = within(card);
    expect(card.dataset.attention).toBe('true');
    expect(c.getByText('Claude')).toBeTruthy();
    expect(c.getByText('5m')).toBeTruthy();
    expect(c.getByText('input needed')).toBeTruthy();
    expect(c.getByText('~/Wakecap/Backend/svc')).toBeTruthy();
    expect(c.getByLabelText('cwd drift')).toBeTruthy();
    expect(c.getByText('Bash')).toBeTruthy();
    expect(c.getByText('run the tests again')).toBeTruthy();
    expect(c.getByText('$1.25')).toBeTruthy();
    expect(c.getByText('ctx 42%')).toBeTruthy();
    expect(c.getByText('SAF-1787')).toBeTruthy();
    expect(c.getByRole('link', { name: 'PR #231' }).getAttribute('href')).toBe(
      'https://github.com/example-org/svc/pull/231',
    );
    expect(c.getByRole('list', { name: 'Stage' }).querySelector('[aria-current="step"]')?.textContent).toBe(
      'Test',
    );
    expect(c.getByText('✓ 16 · ✗ 2').closest('[data-failed]')?.getAttribute('data-failed')).toBe('true');
    expect(c.getByText('2 jobs')).toBeTruthy();
    expect(c.getByText('bypass')).toBeTruthy();
    expect(c.getByText('3 agents')).toBeTruthy();
    expect(c.getByRole('link', { name: 'Diff' }).getAttribute('href')).toBe(
      `/review/${full.source}/${full.id}`,
    );
  });

  it('marks a non-attention status and drops Stop once the session ended', async () => {
    const user = userEvent.setup();
    const busy = liveSessionFixture({ id: 's-busy', name: 'Busy one' }, { status: 'busy' });
    const { unmount } = renderWithProviders(
      <SessionCard session={busy} now={NOW} pinned={false} onTogglePin={() => {}} />,
      { api: api() },
    );
    const busyCard = await screen.findByRole('article', { name: 'Busy one — Busy' });
    expect(busyCard.dataset.attention).toBe('false');
    await openMenu(user, within(busyCard).getByRole('button', { name: 'More actions for Busy one' }));
    expect(await screen.findByRole('menuitem', { name: 'Stop session…' })).toBeTruthy();
    await user.keyboard('{Escape}');
    unmount();

    const ended = liveSessionFixture({ id: 's-end', name: 'Ended one' }, { status: 'ended' });
    renderWithProviders(<SessionCard session={ended} now={NOW} pinned={false} onTogglePin={() => {}} />, {
      api: api(),
    });
    const endedCard = await screen.findByRole('article', { name: 'Ended one — Ended' });
    expect(endedCard.dataset.attention).toBe('false');
    await openMenu(user, within(endedCard).getByRole('button', { name: 'More actions for Ended one' }));
    await screen.findByRole('menuitem', { name: 'Pin to split' });
    expect(screen.queryByRole('menuitem', { name: 'Stop session…' })).toBeNull();
  });

  it('opens the terminal for owned sessions and stops after confirmation', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    useTerminalStore.setState({ open });
    renderWithProviders(<SessionCard session={full} now={NOW} pinned={false} onTogglePin={() => {}} />, {
      api: api(),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Terminal' }));
    expect(open).toHaveBeenCalledWith('pty-1', 'SLA weekends');
    const askToStop = async () => {
      await openMenu(user, screen.getByRole('button', { name: 'More actions for SLA weekends' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Stop session…' }));
      return screen.findByRole('alertdialog', { name: 'Stop “SLA weekends”?' });
    };
    let dialog = await askToStop();
    expect(within(dialog).getByText('/Users/test/Wakecap/Backend/svc')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sessionsKill).not.toHaveBeenCalled();
    dialog = await askToStop();
    await user.click(within(dialog).getByRole('button', { name: 'Stop session' }));
    await vi.waitFor(() => expect(sessionsKill).toHaveBeenCalledWith('claude', 's-live', true));
    expect(sessionsKill).toHaveBeenCalledTimes(1);
  });

  it('hides the terminal button for observed sessions and remembers open-in per project', async () => {
    const user = userEvent.setup();
    const observed = liveSessionFixture({}, { ownership: 'observed' });
    renderWithProviders(<SessionCard session={observed} now={NOW} pinned onTogglePin={() => {}} />, {
      api: api(),
    });
    await screen.findByRole('article');
    expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull();
    await openMenu(user, screen.getByRole('button', { name: /^More actions for / }));
    expect(await screen.findByRole('menuitem', { name: 'Unpin from split' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await openMenu(user, screen.getByRole('button', { name: 'Open in app' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Finder' }));
    expect(useLiveLayoutStore.getState().openInByProject.wakecap).toBe('finder');
    fireEvent.click(screen.getByRole('button', { name: 'Open in Finder' }));
    await vi.waitFor(() => expect(sessionsOpenIn).toHaveBeenCalledWith('claude', 's1', 'finder', true));
  });

  it('copies the resume command and toggles the pin from the actions menu', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const onTogglePin = vi.fn();
    renderWithProviders(<SessionCard session={full} now={NOW} pinned={false} onTogglePin={onTogglePin} />, {
      api: api(),
    });
    const more = await screen.findByRole('button', { name: 'More actions for SLA weekends' });
    await openMenu(user, more);
    await user.click(await screen.findByRole('menuitem', { name: 'Copy resume command' }));
    expect(writeText).toHaveBeenCalledWith(`cd '/Users/test/Wakecap' && claude --resume s-live`);
    await openMenu(user, more);
    await user.click(await screen.findByRole('menuitem', { name: 'Pin to split' }));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });
});
