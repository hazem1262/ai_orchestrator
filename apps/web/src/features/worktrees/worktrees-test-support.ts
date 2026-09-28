import type { WorktreeView } from '@orc/core';
import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

// Shared by the worktrees feature's test files. Radix's DropdownMenu leaves the whole test file's
// jsdom `document` in a state where a later, freshly-rendered DropdownMenu instance never opens
// again once an earlier one in the same file has opened and been torn down (confirmed against a
// two-line repro with no app code involved: two independent renders of a bare `DropdownMenu`, one
// per `it()`, in the same file). Vitest isolates `document` and the module registry per test
// FILE, not per test, so each file below opens the row menu at most once per render tree — split
// further into new files rather than adding another fresh-render open to an existing one.

export const view = (p: Partial<WorktreeView>): WorktreeView => ({
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

/** Run, Sync and Archive live behind the row's "More actions" menu; this opens it. Radix's
 *  DropdownMenu opens on a real pointer/click sequence, which `userEvent` gives and a bare
 *  `fireEvent.click` does not. */
export async function openRowMenu(user: ReturnType<typeof userEvent.setup>, branch: string) {
  await user.click(await screen.findByRole('button', { name: `More actions for ${branch}` }));
}

// Phone-width media query, matching the pattern in AppShell.phone-nav.test.tsx.
export function fakeMatchMedia(matches: boolean) {
  return (query: string): MediaQueryList =>
    ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
