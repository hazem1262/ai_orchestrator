import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/terminals.ts';
import { createFakeApi, type FakeApi } from '@/test/fake-api.ts';
import { renderWithProviders } from '@/test/render.tsx';
import { WorktreesPage } from './WorktreesPage.tsx';
import { fakeMatchMedia, view } from './worktrees-test-support.ts';

// This file opens the row menu on a fresh render exactly once (see worktrees-test-support.ts for
// why that budget matters), so it stays separate from WorktreesPage.test.tsx.

let api: FakeApi;

beforeEach(() => {
  useTerminalStore.setState({ tabs: [], active: null });
  vi.stubGlobal('matchMedia', fakeMatchMedia(true));
  api = createFakeApi({
    worktreesList: async () => [
      view({
        path: '/r',
        branch: 'main',
        isMain: true,
        origin: 'config',
        createdByApp: false,
        ticket: null,
        sessionPks: [],
      }),
      view({}),
      view({
        path: '/r/.worktrees/ext',
        branch: 'fix/SAF-2-ext',
        ticket: 'SAF-2',
        createdByApp: false,
        origin: 'worktree-dir',
        dirty: true,
        prStatus: {
          pr: { repo: 'o/r', number: 2, url: 'https://github.com/o/r/pull/2' },
          state: 'open',
          title: 't',
          checks: 'failure',
          review: 'none',
          updatedAt: 'x',
          headRef: 'fix/SAF-2-ext',
          failedChecks: ['unit'],
        },
      }),
    ],
    worktreesDiscover: async () => [],
    worktreesOpen: (async () => ({ ok: true })) as unknown as FakeApi['worktreesOpen'],
  });
});

describe('WorktreesPage phone layout', () => {
  it('omits the ticket and PR fields on a card that has neither', async () => {
    renderWithProviders(<WorktreesPage />, { api });
    const card = await screen.findByRole('article', { name: 'feat/SAF-1-x' });
    expect(within(card).queryByText('PR', { exact: false })).toBeNull();
    // Sibling card does carry a PR: the field only disappears when there is none to show.
    const withPr = screen.getByRole('article', { name: 'fix/SAF-2-ext' });
    expect(within(withPr).getByText('#2 · checks failing')).toBeDefined();
  });

  it('still reaches IDE, Terminal and the row menu from a card', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorktreesPage />, { api });
    const card = await screen.findByRole('article', { name: 'fix/SAF-2-ext' });
    expect(within(card).getByRole('button', { name: 'Open fix/SAF-2-ext in VS Code' })).toBeDefined();
    expect(within(card).getByRole('button', { name: 'Open terminal in fix/SAF-2-ext' })).toBeDefined();
    await user.click(within(card).getByRole('button', { name: 'More actions for fix/SAF-2-ext' }));
    expect(await screen.findByRole('menuitem', { name: 'Archive fix/SAF-2-ext' })).toBeDefined();
  });
});
