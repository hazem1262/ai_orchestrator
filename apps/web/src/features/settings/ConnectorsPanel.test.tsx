import { ApiRequestError, type ConnectorStatus } from '@orc/api-contract';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 } from '../../test/p3-render.tsx';
import { ConnectorsPanel } from './ConnectorsPanel.tsx';

const T = '2026-09-17T10:00:00.000Z';
const linearOk: ConnectorStatus = {
  id: 'linear',
  connected: true,
  status: 'ok',
  authKind: 'api_key',
  accountLabel: 'Test User <me@example.com>',
  connectedAt: T,
  lastCheckedAt: T,
  oauthConfigured: false,
};
const slackOff: ConnectorStatus = {
  id: 'slack',
  connected: false,
  status: 'unauthenticated',
  authKind: null,
  accountLabel: null,
  connectedAt: null,
  lastCheckedAt: null,
  oauthConfigured: false,
};

describe('ConnectorsPanel', () => {
  afterEach(() => {
    setApiClientForTests(null);
    vi.restoreAllMocks();
  });

  it('connects with a pasted token and disconnects after confirmation', async () => {
    const connectorsSetToken = vi.fn(async () => ({ ...slackOff, connected: true, status: 'ok' as const }));
    const connectorsDisconnect = vi.fn(async () => ({ ok: true as const }));
    setApiClientForTests(
      fakeApi({ connectorsList: async () => [linearOk, slackOff], connectorsSetToken, connectorsDisconnect }),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderP3(<ConnectorsPanel />);

    const slack = await screen.findByRole('region', { name: 'Slack connector' });
    fireEvent.change(within(slack).getByLabelText('Token'), { target: { value: 'xoxp-1234567890-abc' } });
    fireEvent.click(within(slack).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(connectorsSetToken).toHaveBeenCalledWith('slack', 'xoxp-1234567890-abc'));

    const linear = screen.getByRole('region', { name: 'Linear connector' });
    expect(within(linear).getByText('Test User <me@example.com>')).toBeTruthy();
    fireEvent.click(within(linear).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(connectorsDisconnect).toHaveBeenCalledWith('linear', true));
  });

  it('keeps OAuth disabled until the app is configured, then saves the app', async () => {
    const connectorsSetApp = vi.fn(async () => ({ ok: true as const }));
    setApiClientForTests(fakeApi({ connectorsList: async () => [linearOk, slackOff], connectorsSetApp }));
    renderP3(<ConnectorsPanel />);
    const slack = await screen.findByRole('region', { name: 'Slack connector' });
    expect(
      (within(slack).getByRole('button', { name: 'Connect with Slack' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(slack).getByRole('button', { name: 'OAuth app…' }));
    fireEvent.change(within(slack).getByLabelText('Client ID'), { target: { value: '123.456' } });
    fireEvent.change(within(slack).getByLabelText('Client secret'), { target: { value: 'shhh-secret-1' } });
    fireEvent.click(within(slack).getByRole('button', { name: 'Save OAuth app' }));
    await waitFor(() => expect(connectorsSetApp).toHaveBeenCalledWith('slack', '123.456', 'shhh-secret-1'));
  });

  it('shows server errors', async () => {
    const err = new ApiRequestError(400, 'invalid_token', 'Slack rejected the token');
    setApiClientForTests(
      fakeApi({
        connectorsList: async () => [linearOk, slackOff],
        connectorsSetToken: vi.fn(async () => Promise.reject(err)),
      }),
    );
    renderP3(<ConnectorsPanel />);
    const slack = await screen.findByRole('region', { name: 'Slack connector' });
    fireEvent.change(within(slack).getByLabelText('Token'), { target: { value: 'xoxp-1234567890-abc' } });
    fireEvent.click(within(slack).getByRole('button', { name: 'Connect' }));
    expect((await within(slack).findByRole('alert')).textContent).toContain('Slack rejected the token');
  });
});
