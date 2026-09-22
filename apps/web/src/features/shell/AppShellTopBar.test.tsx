import type { Project } from '@orc/core';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { useLaunchStore } from '../../stores/launch.ts';
import { useProjectStore } from '../../stores/project.ts';
import { inboxItemFixture } from '../../test/factories.ts';
import { createFakeApi } from '../../test/fake-api.ts';
import { renderWithProviders } from '../../test/render.tsx';
import { AppShell } from './AppShell.tsx';

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
  close(): void {
    // closed by the hook on unmount
  }
}

const api = () =>
  createFakeApi({
    projectsList: vi.fn(async () => projects),
    inboxList: vi.fn(async () => [
      inboxItemFixture({ id: 'a' }),
      inboxItemFixture({ id: 'b' }),
      inboxItemFixture({ id: 'c' }),
    ]),
  });

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWS);
  window.__ORC_TOKEN__ = 'shell-token';
  useProjectStore.setState({ projectId: 'wakecap' });
  useLaunchStore.setState({ open: false, preset: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__ORC_TOKEN__;
  document.title = '';
  setApiClientForTests(null);
});

describe('AppShell top bar', () => {
  it('shows the open inbox count and links it to /inbox', async () => {
    renderWithProviders(<AppShell>body</AppShell>, { api: api() });
    const link = await screen.findByRole('link', { name: 'Inbox, 3 open' });
    expect(link.getAttribute('href')).toBe('/inbox');
  });

  it('opens the launch dialog from the New session button', async () => {
    renderWithProviders(<AppShell>body</AppShell>, { api: api() });
    fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
    expect(useLaunchStore.getState().open).toBe(true);
    expect(await screen.findByRole('dialog', { name: 'New session' })).toBeTruthy();
  });
});
