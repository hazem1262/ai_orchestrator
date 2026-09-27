import type { AwayState, RemoteDevice, RemoteStatus } from '@orc/api-contract';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { fakeApi, renderP3 as renderWithClient } from '../../test/p3-render.tsx';
import { RemotePanel } from './RemotePanel.tsx';

const status: RemoteStatus = {
  enabled: true,
  origin: 'https://mac.tail1234.ts.net',
  allowedLogin: 'me@example.com',
  isRemote: false,
  deviceId: null,
  stepUpValidUntil: null,
  funnelDetected: false,
  pairingActiveUntil: null,
};
const device: RemoteDevice = {
  id: 'd1',
  name: 'iPhone',
  login: 'me@example.com',
  createdAt: '2026-09-17T10:00:00.000Z',
  lastSeenAt: null,
  revokedAt: null,
  credentials: 1,
};
const away: AwayState = { away: false, mode: 'auto', reason: 'present', idleSeconds: 12 };

describe('RemotePanel', () => {
  afterEach(() => {
    setApiClientForTests(null);
    vi.restoreAllMocks();
  });

  it('shows the pairing code and URL', async () => {
    const remoteCreatePairing = vi.fn(async () => ({
      code: 'ABCD2345',
      expiresAt: '2026-09-17T10:05:00.000Z',
      url: 'https://mac.tail1234.ts.net/pair',
    }));
    setApiClientForTests(
      fakeApi({
        remoteStatus: async () => status,
        remoteDevices: async () => [device],
        awayGet: async () => away,
        remoteCreatePairing,
      }),
    );
    renderWithClient(<RemotePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create pairing code' }));
    expect(await screen.findByText('ABCD2345')).toBeTruthy();
    expect(screen.getByText('https://mac.tail1234.ts.net/pair')).toBeTruthy();
  });

  it('revokes a device after confirmation and switches away mode', async () => {
    const remoteRevokeDevice = vi.fn(async () => ({ ok: true as const }));
    const awaySet = vi.fn(async () => ({
      ...away,
      away: true,
      mode: 'on' as const,
      reason: 'manual' as const,
    }));
    setApiClientForTests(
      fakeApi({
        remoteStatus: async () => status,
        remoteDevices: async () => [device],
        awayGet: async () => away,
        remoteRevokeDevice,
        awaySet,
      }),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithClient(<RemotePanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke iPhone' }));
    await waitFor(() => expect(remoteRevokeDevice).toHaveBeenCalledWith('d1'));
    fireEvent.click(screen.getByRole('button', { name: 'Away now' }));
    await waitFor(() => expect(awaySet).toHaveBeenCalledWith('on'));
  });

  it('warns when a Funnel is detected', async () => {
    setApiClientForTests(
      fakeApi({
        remoteStatus: async () => ({ ...status, funnelDetected: true }),
        remoteDevices: async () => [],
        awayGet: async () => away,
      }),
    );
    renderWithClient(<RemotePanel />);
    expect((await screen.findByRole('alert')).textContent).toContain('Funnel');
  });
});
