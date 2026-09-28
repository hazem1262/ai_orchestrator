import type { RemoteStatus } from '@orc/api-contract';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { clearDeviceToken, readDeviceToken } from '../../api/token.ts';
import { fakeApi, renderP3 as renderWithClient } from '../../test/p3-render.tsx';
import { PairPage } from './PairPage.tsx';

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

function codeBoxes() {
  return within(screen.getByRole('group', { name: 'Pairing code' })).getAllByRole('textbox');
}

function pasteCode(value: string) {
  const [first] = codeBoxes();
  if (!first) throw new Error('expected a first pairing code box');
  fireEvent.paste(first, { clipboardData: { getData: () => value } });
}

describe('PairPage', () => {
  afterEach(() => {
    setApiClientForTests(null);
    clearDeviceToken();
  });

  it('redeems the code, registers a passkey and enables push', async () => {
    const remotePair = vi.fn(async () => ({ deviceId: 'd1', deviceToken: 'device-token-1' }));
    setApiClientForTests(fakeApi({ remoteStatus: async () => status, remotePair }));
    const registerPasskey = vi.fn(async () => {});
    const setupPush = vi.fn(async () => 'subscribed' as const);
    renderWithClient(<PairPage registerPasskey={registerPasskey} setupPush={setupPush} />);

    await screen.findByRole('group', { name: 'Pairing code' });
    pasteCode('abcd2345');
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'My phone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
    await waitFor(() => expect(remotePair).toHaveBeenCalledWith('ABCD2345', 'My phone'));
    expect(readDeviceToken()).toBe('device-token-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Create passkey' }));
    await waitFor(() => expect(registerPasskey).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Enable notifications' }));
    await waitFor(() => expect(setupPush).toHaveBeenCalled());
    expect(await screen.findByRole('link', { name: 'Open the inbox' })).toBeTruthy();
  });

  it('shows pairing errors and keeps no token', async () => {
    setApiClientForTests(
      fakeApi({
        remoteStatus: async () => status,
        remotePair: vi.fn(async () =>
          Promise.reject(Object.assign(new Error('wrong or expired pairing code'), { code: 'invalid_code' })),
        ),
      }),
    );
    renderWithClient(<PairPage registerPasskey={vi.fn()} setupPush={vi.fn(async () => 'denied' as const)} />);
    await screen.findByRole('group', { name: 'Pairing code' });
    pasteCode('ZZZZZZZZ');
    fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
    expect((await screen.findByRole('alert')).textContent).toContain('wrong or expired pairing code');
    expect(readDeviceToken()).toBeNull();
  });

  it('validates the code on submit instead of disabling the button', async () => {
    const remotePair = vi.fn();
    setApiClientForTests(fakeApi({ remoteStatus: async () => status, remotePair }));
    renderWithClient(<PairPage registerPasskey={vi.fn()} setupPush={vi.fn()} />);
    await screen.findByRole('group', { name: 'Pairing code' });
    const submit = screen.getByRole('button', { name: 'Pair this device' });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toContain('Enter all 8 characters of the code.');
    expect(remotePair).not.toHaveBeenCalled();
  });

  it('shows a clear state and a settings link when remote access is off', async () => {
    setApiClientForTests(fakeApi({ remoteStatus: async () => ({ ...status, enabled: false }) }));
    renderWithClient(<PairPage registerPasskey={vi.fn()} setupPush={vi.fn()} />);
    expect(await screen.findByText('Remote access is off')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open remote settings' });
    expect(link.getAttribute('href')).toBe('/settings?section=remote');
    expect(screen.queryByRole('group', { name: 'Pairing code' })).toBeNull();
  });
});
