import type { Project } from '@orc/core';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { usePaletteStore } from '../../stores/palette.ts';
import { useProjectStore } from '../../stores/project.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { AppShell } from './AppShell.tsx';

// Contract: in the phone layout, every top-level section has a link, menu item or option whose
// accessible name contains the section name, either on screen as rendered or after activating one
// button in the phone header (`banner`) or the phone navigation. Which control that is (a "More"
// menu, a sheet, a palette button) is up to the implementation.

const SECTIONS = [
  'Inbox',
  'Live',
  'Worktrees',
  'History',
  'Settings',
  'Audit',
  'Streams',
  'Analytics',
  'Automations',
];

// Header buttons that do something other than navigate.
const NOT_NAVIGATION = /^new session$|^theme/i;

const projects: Project[] = [
  {
    id: 'wakecap',
    name: 'Wakecap',
    pathPrefixes: ['/w'],
    hidden: false,
    lastActivityAt: null,
    sessionCount: 1,
  },
];

class FakeWS {
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() {
    // no reconnect expected
  }
}

function phoneMatchMedia(query: string): MediaQueryList {
  return {
    matches: query.includes('max-width'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  } as MediaQueryList;
}

function renderPhoneShell() {
  return renderWithProviders(<AppShell>body</AppShell>, {
    path: '/inbox',
    api: createFakeApi({ projectsList: vi.fn(async () => projects), inboxList: vi.fn(async () => []) }),
  });
}

function navigableNames(): string[] {
  return ['link', 'menuitem', 'option'].flatMap((role) =>
    screen.queryAllByRole(role).map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()),
  );
}

function phoneControls(): HTMLElement[] {
  const regions = [
    ...screen.queryAllByRole('banner'),
    ...screen.queryAllByRole('navigation', { name: 'Mobile navigation' }),
  ];
  return regions
    .flatMap((r) => within(r).queryAllByRole('button'))
    .filter((b) => !NOT_NAVIGATION.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()));
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWS);
  vi.stubGlobal('matchMedia', phoneMatchMedia);
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
  window.__ORC_TOKEN__ = 'phone-token';
  useProjectStore.setState({ projectId: 'wakecap' });
  usePaletteStore.setState({ open: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__ORC_TOKEN__;
  setApiClientForTests(null);
  usePaletteStore.setState({ open: false });
  document.title = '';
});

describe('phone navigation', () => {
  it('reaches every top-level section from the phone header or navigation', async () => {
    renderPhoneShell();
    await screen.findByRole('navigation', { name: 'Mobile navigation' });
    // The desktop sidebar must not be what satisfies this: it is not rendered on a phone.
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    const reachable = new Set(navigableNames());
    const controlCount = phoneControls().length;
    for (let i = 0; i < controlCount; i++) {
      cleanup();
      usePaletteStore.setState({ open: false });
      renderPhoneShell();
      await screen.findByRole('navigation', { name: 'Mobile navigation' });
      const control = phoneControls()[i];
      if (!control) continue;
      await userEvent.setup().click(control);
      for (const name of navigableNames()) reachable.add(name);
    }
    const names = [...reachable];
    const missing = SECTIONS.filter((s) => !names.some((n) => n.toLowerCase().includes(s.toLowerCase())));
    expect(missing, 'top-level sections with no tap path on a phone').toEqual([]);
  });
});
