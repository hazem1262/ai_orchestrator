import type { Session } from '@orc/core';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { downloadSessionExport } from '@/api/queries/session-detail.ts';
import { useViewModeStore } from '@/stores/view-mode.ts';
import { sessionFixture } from '@/test/factories.ts';
import { createFakeApi, type FakeApi } from '@/test/fake-api.ts';
import { renderWithProviders } from '@/test/render.tsx';
import { crumbParent } from './DetailCrumbs.tsx';
import { SessionDetailPage } from './SessionDetailPage.tsx';
import type { DetailTab } from './tabs/SessionDetailTabs.tsx';

vi.mock('@/api/queries/session-detail.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  downloadSessionExport: vi.fn(async () => undefined),
}));

const live = (status: 'busy' | 'ended'): Session['live'] => ({
  pid: 42,
  status,
  waitingFor: null,
  since: '2026-09-01T09:00:00.000Z',
  ownership: 'observed',
  ptyId: null,
  stage: 'modify',
  currentTool: null,
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: null,
});

function render(session: Session, tab: DetailTab = 'timeline', extra: Partial<FakeApi> = {}) {
  const api = createFakeApi({
    sessionsGet: vi.fn(async () => session),
    sessionsStats: vi.fn(async () => {
      throw new Error('no stats');
    }),
    sessionsDeliverables: vi.fn(async () => []),
    sessionsSafety: vi.fn(async () => ({
      permissionMode: 'default',
      permissionBadge: 'default' as const,
      touchedProd: false,
      prodTouches: [],
    })),
    agncStatus: vi.fn(async () => ({ enabled: false, status: 'disabled', url: null, sessions: 0 })),
    ...extra,
  } as never);
  return renderWithProviders(
    <SessionDetailPage
      source={session.source}
      id={session.id}
      tab={tab}
      agentId={null}
      file={null}
      onNavigate={() => {}}
    />,
    { api },
  );
}

/** Opens a Radix menu from the keyboard. In jsdom a pointer-opened Radix menu stops opening by
 *  pointer in the next test of the same file, so every menu here is opened with Enter. */
async function openMenu(name: string): Promise<HTMLElement> {
  screen.getByRole('button', { name }).focus();
  await userEvent.keyboard('{Enter}');
  return screen.findByRole('menu');
}

afterEach(() => {
  setApiClientForTests(null);
  vi.mocked(downloadSessionExport).mockClear();
});

describe('session detail breadcrumb', () => {
  it('points a finished session back to History', async () => {
    render(sessionFixture({ live: live('ended') }));
    const crumbs = await screen.findByRole('navigation', { name: 'breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'History' }).getAttribute('href')).toBe('/history');
    expect(within(crumbs).getByText('Notification service test check')).toBeTruthy();
  });

  it('points a running session back to Live', async () => {
    render(sessionFixture({ live: live('busy') }));
    const crumbs = await screen.findByRole('navigation', { name: 'breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Live' }).getAttribute('href')).toBe('/live');
  });

  it('keeps a back link on the error state', async () => {
    const api = createFakeApi({
      sessionsGet: vi.fn(async () => {
        throw new Error('session claude:nope not found');
      }),
    });
    renderWithProviders(
      <SessionDetailPage
        source="claude"
        id="nope"
        tab="timeline"
        agentId={null}
        file={null}
        onNavigate={() => {}}
      />,
      { api },
    );
    await screen.findByRole('alert');
    expect(screen.getByRole('link', { name: 'History' })).toBeTruthy();
  });

  it('picks the parent from the live status', () => {
    expect(crumbParent(null).to).toBe('/history');
    expect(crumbParent({ live: live('ended') }).to).toBe('/history');
    expect(crumbParent({ live: live('busy') }).to).toBe('/live');
  });
});

describe('session detail header actions', () => {
  it('has one primary Resume, a Review link, and the rest in menus', async () => {
    render(sessionFixture());
    await screen.findByRole('heading', { level: 1, name: 'Notification service test check' });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Review' }).getAttribute('href')).toBe('/review/claude/s1');
    expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull();

    const more = await openMenu('More actions');
    for (const name of ['Fork', 'Pop out', 'Audit log', 'Export ZIP', 'Export ZIP with secrets (unredacted)'])
      expect(within(more).getByRole('menuitem', { name })).toBeTruthy();
    expect(within(more).getByRole('menuitem', { name: 'Audit log' }).getAttribute('href')).toBe(
      '/audit?sessionPk=claude%3As1',
    );
  });

  it('exports redacted by default and asks before an unredacted export', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    render(sessionFixture());
    await screen.findByRole('heading', { level: 1 });
    await openMenu('More actions');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Export ZIP' }));
    expect(downloadSessionExport).toHaveBeenLastCalledWith('claude', 's1', { redact: true });

    confirm.mockReturnValueOnce(false);
    await openMenu('More actions');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Export ZIP with secrets (unredacted)' }));
    expect(downloadSessionExport).toHaveBeenCalledTimes(1);

    confirm.mockReturnValueOnce(true);
    await openMenu('More actions');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Export ZIP with secrets (unredacted)' }));
    expect(downloadSessionExport).toHaveBeenLastCalledWith('claude', 's1', { redact: false });
  });

  it('opens the share dialog from the Share menu', async () => {
    render(sessionFixture({ tickets: ['SAF-1787'] }));
    await screen.findByRole('heading', { level: 1 });
    const menu = await openMenu('Share');
    for (const name of ['Recap → Linear', 'Handoff → Linear', 'Follow-up ticket', 'Recap → Slack'])
      expect(within(menu).getByRole('menuitem', { name })).toBeTruthy();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Recap → Linear' }));
    expect(await screen.findByRole('dialog', { name: 'Recap to Linear' })).toBeTruthy();
  });
});

describe('session detail tabs', () => {
  it('lists every tab and keeps the view-mode switch inside the transcript', async () => {
    render(sessionFixture());
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Transcript',
      'Terminal',
      'Diff',
      'Files',
      'Agents',
      'Usage',
      'Links',
      'Raw',
    ]);
    const panel = screen.getByRole('tabpanel');
    const verbose = within(within(panel).getByRole('radiogroup', { name: 'View mode' })).getByRole('radio', {
      name: 'Verbose',
    });
    await userEvent.click(verbose);
    expect(useViewModeStore.getState().mode).toBe('verbose');
    expect(verbose.getAttribute('aria-checked')).toBe('true');
  });

  it('explains the terminal tab when the app owns no terminal for the session', async () => {
    render(sessionFixture(), 'terminal');
    expect(await screen.findByText('No terminal in the app')).toBeTruthy();
    expect(screen.getByText('Resume the session to open its terminal here.')).toBeTruthy();
  });

  it('shows the working-tree diff read-only with a link to Review', async () => {
    const reviewGet = vi.fn(async () => ({ cwd: '/Users/test/Wakecap' }));
    const diffGet = vi.fn(async () => ({
      cwd: '/Users/test/Wakecap',
      from: 'HEAD',
      to: 'worktree',
      additions: 1,
      deletions: 1,
      files: [
        {
          path: 'src/a.ts',
          oldPath: null,
          status: 'modified' as const,
          additions: 1,
          deletions: 1,
          patch: '@@ -1 +1 @@\n-old line\n+new line',
          hunks: [],
        },
      ],
    }));
    render(sessionFixture(), 'diff', { reviewGet, diffGet } as never);
    expect(await screen.findByText('+new line')).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(diffGet).toHaveBeenCalledWith({ cwd: '/Users/test/Wakecap' });
    expect(screen.getByRole('link', { name: 'Review and comment' }).getAttribute('href')).toBe(
      '/review/claude/s1',
    );
  });
});
