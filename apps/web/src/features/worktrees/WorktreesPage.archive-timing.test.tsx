import { ApiRequestError } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/terminals.ts';
import { createFakeApi, type FakeApi } from '@/test/fake-api.ts';
import { renderWithProviders } from '@/test/render.tsx';
import { WorktreesPage } from './WorktreesPage.tsx';
import { openRowMenu, view } from './worktrees-test-support.ts';

// This file opens the row menu on a fresh render exactly once (see worktrees-test-support.ts for
// why that budget matters), so it stays separate from the other WorktreesPage test files.

let archive: ReturnType<typeof vi.fn>;
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
  api = createFakeApi({
    worktreesList: async () => [
      view({
        path: '/r/.worktrees/ext',
        branch: 'fix/SAF-2-ext',
        ticket: 'SAF-2',
        createdByApp: false,
        origin: 'worktree-dir',
        dirty: true,
      }),
    ],
    worktreesDiscover: async () => [],
    worktreesArchive: archive as unknown as FakeApi['worktreesArchive'],
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
    const user = userEvent.setup();
    renderWithProviders(<WorktreesPage />, { api });
    await openRowMenu(user, 'fix/SAF-2-ext');
    await user.click(await screen.findByRole('menuitem', { name: 'Archive fix/SAF-2-ext' }));
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
