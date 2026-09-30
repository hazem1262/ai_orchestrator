import { ApiRequestError } from '@orc/api-contract';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '@/stores/project.ts';
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
    expect(screen.getByRole('heading', { name: 'o/r, 3 worktrees' })).toBeDefined();
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

describe('WorktreesPage grouping', () => {
  it('heads each repo group with its GitHub slug or folder name and a count, sorted by name', async () => {
    const list = await api.worktreesList();
    api.worktreesList = vi.fn(async () => [
      ...list,
      view({
        path: '/z/alpha/.worktrees/feat-a',
        repo: '/z/alpha',
        branch: 'feat/a',
        repoSlug: null,
        projectId: 'wakecap',
      }),
    ]) as unknown as FakeApi['worktreesList'];
    renderWithProviders(<WorktreesPage />, { api });
    await screen.findByText('feat/a');
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.getAttribute('aria-label'));
    expect(headings).toEqual(['alpha, 1 worktree', 'o/r, 3 worktrees']);
    expect(screen.getByRole('heading', { name: 'alpha, 1 worktree' }).getAttribute('title')).toBe('/z/alpha');
  });
});

describe('WorktreesPage clean-up', () => {
  const preview = {
    candidates: [
      {
        path: '/r/.worktrees/feat-SAF-1-x',
        repo: '/r',
        repoName: 'o/r',
        branch: 'feat/SAF-1-x',
        reason: 'pr_merged' as const,
        pr: { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' },
      },
      {
        path: '/z/alpha/.worktrees/feat-a',
        repo: '/z/alpha',
        repoName: 'alpha',
        branch: 'feat/a',
        reason: 'in_default_branch' as const,
      },
    ],
    skipped: [
      {
        path: '/r/.worktrees/ext',
        repo: '/r',
        repoName: 'o/r',
        branch: 'fix/SAF-2-ext',
        why: 'uncommitted changes in 1 file(s)',
      },
    ],
  };

  it('previews merged worktrees by repo, runs the confirmed list and shows the results', async () => {
    const cleanupPreview = vi.fn(async () => preview);
    const cleanup = vi.fn(async () => ({
      results: [
        { path: '/r/.worktrees/feat-SAF-1-x', ok: true },
        { path: '/z/alpha/.worktrees/feat-a', ok: false, error: 'uncommitted changes in 2 file(s)' },
      ],
    }));
    api.worktreesCleanupPreview = cleanupPreview as unknown as FakeApi['worktreesCleanupPreview'];
    api.worktreesCleanup = cleanup as unknown as FakeApi['worktreesCleanup'];
    const listCalls = () =>
      (api.worktreesList as unknown as { mock?: { calls: unknown[] } }).mock?.calls.length;
    api.worktreesList = vi.fn(api.worktreesList) as unknown as FakeApi['worktreesList'];
    const user = userEvent.setup();
    renderWithProviders(<WorktreesPage />, { api });
    await screen.findByText('feat/SAF-1-x');

    await user.click(screen.getByRole('button', { name: 'Clean up merged' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Clean up merged worktrees' });
    expect(cleanupPreview).toHaveBeenCalledWith({ projectId: 'wakecap' });
    const r = within(dialog).getByRole('list', { name: 'o/r' });
    expect(within(r).getByText('feat/SAF-1-x')).toBeDefined();
    expect(within(r).getByText('PR merged')).toBeDefined();
    expect(within(r).getByRole('link', { name: '#7' }).getAttribute('href')).toBe(
      'https://github.com/o/r/pull/7',
    );
    const alpha = within(dialog).getByRole('list', { name: 'alpha' });
    expect(within(alpha).getByText('In default branch')).toBeDefined();
    const skipped = within(dialog).getByRole('list', { name: 'Skipped' });
    expect(within(skipped).getByText('fix/SAF-2-ext')).toBeDefined();
    expect(within(skipped).getByText('uncommitted changes in 1 file(s)')).toBeDefined();
    expect(cleanup).not.toHaveBeenCalled();

    const before = listCalls() ?? 0;
    await user.click(within(dialog).getByRole('button', { name: 'Archive 2 worktrees' }));
    await waitFor(() =>
      expect(cleanup).toHaveBeenCalledWith({
        paths: ['/r/.worktrees/feat-SAF-1-x', '/z/alpha/.worktrees/feat-a'],
        confirm: true,
      }),
    );
    expect(await within(dialog).findByText('Archived 1, failed 1')).toBeDefined();
    expect(within(dialog).getByText('uncommitted changes in 2 file(s)')).toBeDefined();
    await waitFor(() => expect(listCalls() ?? 0).toBeGreaterThan(before));
  });

  it('shows an empty state with nothing to confirm when no worktree is merged', async () => {
    api.worktreesCleanupPreview = vi.fn(async () => ({
      candidates: [],
      skipped: [],
    })) as unknown as FakeApi['worktreesCleanupPreview'];
    const user = userEvent.setup();
    renderWithProviders(<WorktreesPage />, { api });
    await screen.findByText('feat/SAF-1-x');
    await user.click(screen.getByRole('button', { name: 'Clean up merged' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Clean up merged worktrees' });
    expect(within(dialog).getByText('No merged worktrees to clean up.')).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: /^Archive/ })).toBeNull();
  });

  it('previews every project when no project is selected', async () => {
    useProjectStore.setState({ projectId: '' });
    const cleanupPreview = vi.fn(async () => ({ candidates: [], skipped: [] }));
    api.worktreesCleanupPreview = cleanupPreview as unknown as FakeApi['worktreesCleanupPreview'];
    const user = userEvent.setup();
    renderWithProviders(<WorktreesPage />, { api });
    await screen.findByText('feat/SAF-1-x');
    await user.click(screen.getByRole('button', { name: 'Clean up merged' }));
    await waitFor(() => expect(cleanupPreview).toHaveBeenCalledWith({}));
    useProjectStore.setState({ projectId: 'wakecap' });
  });
});
