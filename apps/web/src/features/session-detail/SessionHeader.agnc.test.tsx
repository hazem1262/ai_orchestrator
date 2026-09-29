import type { Session } from '@orc/core';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { sessionFixture } from '@/test/factories.ts';
import { createFakeApi } from '@/test/fake-api.ts';
import { renderWithProviders } from '@/test/render.tsx';
import { SessionDetailPage } from './SessionDetailPage.tsx';

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('@/features/mobile/useIsMobile.ts', () => ({
  MOBILE_QUERY: '(max-width: 767px)',
  useIsMobile: () => mobile.value,
}));

const detailProps = { tab: 'timeline', agentId: null, file: null, onNavigate: () => {} } as const;

// Actions that only work for a session on this Mac: they resume/fork a local transcript or share it.
// Resume is a header button; Fork and Pop out sit in the More menu; the share actions in the Share menu.
const LOCAL_BUTTONS = ['Resume', 'Share'];
const LOCAL_MORE_ITEMS = ['Fork', 'Pop out'];
const LOCAL_SHARE_ITEMS = ['Recap → Linear', 'Handoff → Linear', 'Recap → Slack', 'Follow-up ticket'];

// Opened with Enter: in jsdom a pointer-opened Radix menu stops opening by pointer in later tests.
async function menuItems(trigger: string): Promise<string[]> {
  screen.getByRole('button', { name: trigger }).focus();
  await userEvent.keyboard('{Enter}');
  const names = within(await screen.findByRole('menu'))
    .getAllByRole('menuitem')
    .map((el) => el.textContent ?? '');
  await userEvent.keyboard('{Escape}');
  return names;
}

const agncSession = sessionFixture({
  id: 'ag-1',
  source: 'agnc',
  availability: 'remote',
  name: 'Remote SLA fix',
  transcriptPath: null as unknown as string,
});
const claudeSession = sessionFixture({ id: 's1', source: 'claude', name: 'Local session' });

function render(session: Session) {
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
    agncStatus: vi.fn(async () => ({
      enabled: true,
      status: 'connected',
      url: 'https://x/mcp',
      sessions: 1,
    })),
    agncMessages: vi.fn(async () => []),
    agncEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
  } as never);
  return renderWithProviders(<SessionDetailPage source={session.source} id={session.id} {...detailProps} />, {
    api,
  });
}

afterEach(() => {
  mobile.value = false;
  setApiClientForTests(null);
});

describe('SessionHeader actions for a remote AGNC session', () => {
  it('guard: a local claude session shows the local-only actions', async () => {
    render(claudeSession);
    await screen.findByRole('heading', { level: 1, name: 'Local session' });
    for (const name of LOCAL_BUTTONS) expect(screen.queryByRole('button', { name })).not.toBeNull();
    expect(await menuItems('More actions')).toEqual(expect.arrayContaining(LOCAL_MORE_ITEMS));
    expect(await menuItems('Share')).toEqual(expect.arrayContaining(LOCAL_SHARE_ITEMS));
  });

  it('an agnc session shows no Resume, Fork or local share actions', async () => {
    render(agncSession);
    await screen.findByRole('heading', { level: 1, name: 'Remote SLA fix' });
    const present = LOCAL_BUTTONS.filter((name) => screen.queryByRole('button', { name }) !== null);
    expect(present).toEqual([]);
    const more = await menuItems('More actions');
    expect(more.filter((name) => [...LOCAL_MORE_ITEMS, ...LOCAL_SHARE_ITEMS].includes(name))).toEqual([]);
  });

  it('guard: at phone width a local claude session shows the "replies are off" note', async () => {
    mobile.value = true;
    render(claudeSession);
    await screen.findByRole('heading', { level: 1, name: 'Local session' });
    expect(screen.queryByText(/replies are off/)).not.toBeNull();
  });

  it('at phone width an agnc session shows no local reply note or composer', async () => {
    mobile.value = true;
    render(agncSession);
    await screen.findByRole('heading', { level: 1, name: 'Remote SLA fix' });
    expect(screen.queryByText(/replies are off/)).toBeNull();
    expect(screen.queryByRole('form', { name: 'Reply' })).toBeNull();
  });
});
