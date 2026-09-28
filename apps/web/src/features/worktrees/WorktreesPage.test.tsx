import { ApiRequestError } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/terminals.ts';
import { createFakeApi, type FakeApi } from '@/test/fake-api.ts';
import { renderWithProviders } from '@/test/render.tsx';
import { WorktreesPage } from './WorktreesPage.tsx';
import { openRowMenu, view } from './worktrees-test-support.ts';

let archive: ReturnType<typeof vi.fn>;
let sync: ReturnType<typeof vi.fn>;
let script: ReturnType<typeof vi.fn>;
let api: FakeApi;

beforeEach(() => {
  useTerminalStore.setState({ tabs: [], active: null });
  archive = vi.fn(async (body: { confirm: boolean; confirmExternal: boolean }) => {
    if (!body.confirm)
      throw new ApiRequestError(409, 'confirmation_required', 'c', {
        summary: 'Remove worktree /r/.worktrees/ext',
        external: true,
      });
    if (!body.confirmExternal) throw new ApiRequestError(409, 'external_worktree', 'external');
    return { ok: true as const };
  });
  sync = vi.fn(async () => ({ files: 3 }));
  script = vi.fn(async () => ({ ptyId: 'pty-1' }));
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
    worktreesArchive: archive as unknown as FakeApi['worktreesArchive'],
    worktreesOpen: (async () => ({ ok: true })) as unknown as FakeApi['worktreesOpen'],
    worktreesScript: script as unknown as FakeApi['worktreesScript'],
    worktreesSync: sync as unknown as FakeApi['worktreesSync'],
  });
});

describe('WorktreesPage', () => {
  it('groups by repo, in one shared table, and shows ticket, origin, dirty and PR state', async () => {
    renderWithProviders(<WorktreesPage />, { api });
    expect(await screen.findByText('feat/SAF-1-x')).toBeDefined();
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: '/r' })).toBeDefined();
    expect(screen.getByText('external')).toBeDefined();
    expect(screen.getByText('dirty')).toBeDefined();
    expect(screen.getByText('#2 · checks failing')).toBeDefined();
    // The main checkout gets no destructive-action menu at all.
    expect(screen.queryByRole('button', { name: 'More actions for main' })).toBeNull();
  });

  it('runs, syncs and archives an external worktree from the row menu', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorktreesPage />, { api });

    await openRowMenu(user, 'fix/SAF-2-ext');
    await user.click(await screen.findByRole('menuitem', { name: 'Run fix/SAF-2-ext' }));
    await waitFor(() =>
      expect(script).toHaveBeenCalledWith({ path: '/r/.worktrees/ext', which: 'run', confirm: false }),
    );
    expect(useTerminalStore.getState().tabs).toEqual([{ ptyId: 'pty-1', title: 'run fix/SAF-2-ext' }]);

    await openRowMenu(user, 'fix/SAF-2-ext');
    await user.click(await screen.findByRole('menuitem', { name: 'Sync fix/SAF-2-ext to main checkout' }));
    await waitFor(() => expect(sync).toHaveBeenCalledWith({ path: '/r/.worktrees/ext', confirm: false }));

    await openRowMenu(user, 'fix/SAF-2-ext');
    await user.click(await screen.findByRole('menuitem', { name: 'Archive fix/SAF-2-ext' }));
    expect(await screen.findByText('Remove worktree /r/.worktrees/ext')).toBeDefined();
    const confirm = screen.getByRole('button', { name: 'Archive' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('I understand this worktree was created outside the app'));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(archive).toHaveBeenLastCalledWith({
        path: '/r/.worktrees/ext',
        confirm: true,
        confirmExternal: true,
      }),
    );
  });
});
