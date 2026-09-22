import type { Project } from '@orc/core';
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  static urls: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    FakeWS.urls.push(url);
  }
  close() {
    // closed by the hook on unmount; no reconnect expected
  }
}

describe('AppShell live wiring', () => {
  beforeEach(() => {
    FakeWS.urls = [];
    vi.stubGlobal('WebSocket', FakeWS);
    window.__ORC_TOKEN__ = 'shell-token';
    useProjectStore.setState({ projectId: 'wakecap' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.__ORC_TOKEN__;
    document.title = '';
  });

  it('opens /ws with the token and puts the open inbox count in the tab title', async () => {
    const inboxList = vi.fn(async () => [inboxItemFixture({ id: 'a' }), inboxItemFixture({ id: 'b' })]);
    const api = createFakeApi({ projectsList: vi.fn(async () => projects), inboxList });
    renderWithProviders(<AppShell>body</AppShell>, { api });
    await waitFor(() => expect(document.title).toBe('(2) Orchestrator'));
    expect(inboxList).toHaveBeenCalledWith(
      expect.objectContaining({ state: ['open'], projectId: 'wakecap' }),
    );
    expect(FakeWS.urls).toHaveLength(1);
    expect(FakeWS.urls[0]).toMatch(/^wss?:\/\/[^/]+\/ws\?token=shell-token$/);
  });
});
