import { ApiRequestError } from '@orc/api-contract';
import type { WorktreeView } from '@orc/core';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeApi, type FakeApi } from '@/test/fake-api.ts';
import { renderWithProviders } from '@/test/render.tsx';
import { WorktreesPage } from './WorktreesPage.tsx';

const view = (p: Partial<WorktreeView>): WorktreeView => ({
  path: '/r/.worktrees/feat-SAF-1-x',
  repo: '/r',
  branch: 'feat/SAF-1-x',
  base: 'main',
  ticket: 'SAF-1',
  dirty: false,
  prUrl: null,
  state: 'active',
  createdByApp: true,
  head: 'abc',
  isMain: false,
  origin: 'app',
  sessionPks: ['claude:s1'],
  projectId: 'wakecap',
  prStatus: null,
  updatedAt: '2026-09-17T10:00:00Z',
  ...p,
});

let archive: ReturnType<typeof vi.fn>;
let api: FakeApi;

beforeEach(() => {
  archive = vi.fn(async (body: { confirm: boolean; confirmExternal: boolean }) => {
    if (!body.confirm)
      throw new ApiRequestError(409, 'confirmation_required', 'c', {
        summary: 'Remove worktree /r/.worktrees/ext',
        external: true,
      });
    if (!body.confirmExternal) throw new ApiRequestError(409, 'external_worktree', 'external');
    return { ok: true as const };
  });
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
    worktreesScript: (async () => ({ ptyId: 'pty-1' })) as unknown as FakeApi['worktreesScript'],
    worktreesSync: (async () => ({ files: 0 })) as unknown as FakeApi['worktreesSync'],
  });
});

describe('WorktreesPage', () => {
  it('groups by repo and shows ticket, origin, dirty and PR state', async () => {
    renderWithProviders(<WorktreesPage />, { api });
    expect(await screen.findByText('feat/SAF-1-x')).toBeDefined();
    expect(screen.getByRole('heading', { name: '/r' })).toBeDefined();
    expect(screen.getByText('external')).toBeDefined();
    expect(screen.getByText('dirty')).toBeDefined();
    expect(screen.getByText('#2 · checks failing')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Archive main' })).toBeNull();
  });

  it('archives an external worktree only after both confirmations', async () => {
    renderWithProviders(<WorktreesPage />, { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Archive fix/SAF-2-ext' }));
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

describe('WorktreesPage archive confirmation timing', () => {
  // GitConfirmDialog resets `ack` in a passive effect keyed on the request. A user who ticks the
  // external-worktree box in the first frame the dialog is on screen, before that effect has run,
  // has the tick undone by the effect, so "Archive" stays disabled. The box is ticked here from a
  // MutationObserver callback, which runs right after the commit that shows the dialog.
  it('keeps the external acknowledgement ticked in the first frame the dialog is shown', async () => {
    let ticked = false;
    let checkedAfterTick: boolean | null = null;
    const mo = new MutationObserver(() => {
      if (ticked) return;
      const box = screen.queryByLabelText('I understand this worktree was created outside the app');
      if (!box) return;
      ticked = true;
      fireEvent.click(box);
      checkedAfterTick = box.getAttribute('aria-checked') === 'true';
    });
    mo.observe(document.body, { childList: true, subtree: true });
    renderWithProviders(<WorktreesPage />, { api });
    fireEvent.click(await screen.findByRole('button', { name: 'Archive fix/SAF-2-ext' }));
    await waitFor(() => expect(ticked).toBe(true));
    mo.disconnect();
    await new Promise((r) => setTimeout(r, 50));
    // The tick itself lands: the box reads checked straight after the click.
    expect(checkedAfterTick).toBe(true);
    const box = screen.getByRole('checkbox', {
      name: 'I understand this worktree was created outside the app',
    });
    const confirm = screen.getByRole('button', { name: 'Archive' }) as HTMLButtonElement;
    expect({
      ackChecked: box.getAttribute('aria-checked') === 'true',
      archiveDisabled: confirm.disabled,
    }).toEqual({
      ackChecked: true,
      archiveDisabled: false,
    });
  });
});
