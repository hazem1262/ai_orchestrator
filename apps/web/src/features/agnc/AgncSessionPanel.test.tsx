import type { AgncMessage, AgncStatus } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '@/api/client.ts';
import { liveFixture, sessionFixture as makeSession } from '@/test/factories.ts';
import { fakeApi, renderP3 as renderWithClient } from '@/test/p3-render.tsx';
import { AgncConnectCard } from './AgncConnectCard.tsx';
import { AgncSessionPanel } from './AgncSessionPanel.tsx';
import { HandoffToAgncButton } from './HandoffToAgncButton.tsx';

const status: AgncStatus = {
  enabled: true,
  status: 'unauthenticated',
  url: 'https://agnc.wakecap.ai/mcp',
  sessions: 0,
};
const messages: AgncMessage[] = [
  { id: 'm1', role: 'user', status: null, text: 'fix the SLA', createdAt: '2026-09-18T09:00:00.000Z' },
];

afterEach(() => setApiClientForTests(null));

function api(over: Record<string, unknown> = {}) {
  const stubs = {
    agncStatus: vi.fn(async () => status),
    agncConnect: vi.fn(async () => ({ authorizationUrl: 'https://agnc.wakecap.ai/authorize' })),
    agncMessages: vi.fn(async () => messages),
    agncEvents: vi.fn(async () => ({
      items: [{ id: 'e1', type: 'tool_call', messageId: null, text: 'ran tests', createdAt: null }],
      nextCursor: null,
    })),
    agncPrompt: vi.fn(async () => ({ ok: true as const })),
    agncHandoff: vi.fn(async () => ({
      id: 'ag-new',
      title: null,
      status: 'queued',
      repoOwner: null,
      repoName: null,
      branch: null,
      prUrl: null,
      url: null,
      createdAt: null,
      updatedAt: null,
    })),
    ...over,
  };
  setApiClientForTests(fakeApi(stubs));
  return stubs;
}

describe('AgncConnectCard', () => {
  it('opens the authorisation URL when connecting', async () => {
    const stubs = api();
    const open = vi.fn();
    renderWithClient(<AgncConnectCard openUrl={open} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect AGNC' }));
    await waitFor(() => expect(stubs.agncConnect).toHaveBeenCalled());
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://agnc.wakecap.ai/authorize'));
  });
});

describe('AgncSessionPanel', () => {
  it('shows messages and events and sends a prompt', async () => {
    const stubs = api();
    renderWithClient(
      <AgncSessionPanel
        session={makeSession({
          id: 'ag-1',
          source: 'agnc',
          availability: 'remote',
          live: liveFixture({ status: 'busy', ownership: 'observed', ptyId: null }),
        })}
      />,
    );
    expect(await screen.findByText('fix the SLA')).toBeTruthy();
    expect(screen.getByText('ran tests')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'keep going' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to AGNC' }));
    await waitFor(() => expect(stubs.agncPrompt).toHaveBeenCalledWith('ag-1', { prompt: 'keep going' }));
  });
});

describe('HandoffToAgncButton', () => {
  it('hands off after confirmation', async () => {
    const stubs = api();
    const confirm = vi.fn(() => true);
    renderWithClient(<HandoffToAgncButton session={makeSession({ id: 's1' })} confirm={confirm} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hand off to AGNC' }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(stubs.agncHandoff).toHaveBeenCalledWith({ source: 'claude', id: 's1' }));
    expect(await screen.findByText(/ag-new/)).toBeTruthy();
  });
});
