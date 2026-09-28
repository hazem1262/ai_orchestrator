import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../../stores/project.ts';
import { listItemFixture } from '../../test/factories.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { MOBILE_QUERY } from '../mobile/useIsMobile.ts';
import { HistoryPage } from './HistoryPage.tsx';

/** Forces `useIsMobile()` to read `true`, the same media query the real phone layout matches. */
function mockPhoneWidth() {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === MOBILE_QUERY,
    media: query,
    addEventListener: (_: 'change', cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: 'change', cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
  }));
}

const items = [
  listItemFixture({ id: 's-basic', name: 'Notification service test check', labels: ['later'] }),
];

describe('History on a phone', () => {
  beforeEach(() => {
    useProjectStore.setState({ projectId: 'wakecap' });
    mockPhoneWidth();
  });
  afterEach(() => {
    // @ts-expect-error test-only cleanup of the mocked global
    window.matchMedia = undefined;
  });

  it('renders cards instead of a table, with the title at full width', async () => {
    const api = createFakeApi({ sessionsList: vi.fn(async () => ({ items, nextCursor: null })) });
    renderWithProviders(<HistoryPage search={{}} onSearchChange={() => {}} />, { api });
    const link = await screen.findByRole('link', { name: 'Notification service test check' });
    expect(screen.queryByRole('table')).toBeNull();
    const card = link.closest('[data-slot="card"]');
    if (!card) throw new Error('card missing');
    expect(within(card as HTMLElement).getByText('later')).toBeTruthy();
  });

  it('hides a row from its card menu', async () => {
    const api = createFakeApi({ sessionsList: vi.fn(async () => ({ items, nextCursor: null })) });
    renderWithProviders(<HistoryPage search={{}} onSearchChange={() => {}} />, { api });
    const link = await screen.findByRole('link', { name: 'Notification service test check' });
    const card = within(link.closest('[data-slot="card"]') as HTMLElement);
    const menuTrigger = card.getByRole('button', {
      name: 'More actions for Notification service test check',
    });
    menuTrigger.focus();
    await userEvent.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Hide' }));
    await waitFor(() =>
      expect(api.sessionsLabel).toHaveBeenCalledWith('claude', 's-basic', ['later', 'hidden']),
    );
  });
});
