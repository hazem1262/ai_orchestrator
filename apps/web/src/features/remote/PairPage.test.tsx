import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests } from '../../api/client.ts';
import { clearDeviceToken, readDeviceToken } from '../../api/token.ts';
import { fakeApi, renderP3 as renderWithClient } from '../../test/p3-render.tsx';
import { PairPage } from './PairPage.tsx';

describe('PairPage', () => {
  afterEach(() => {
    setApiClientForTests(null);
    clearDeviceToken();
  });

  it('redeems the code, registers a passkey and enables push', async () => {
    const remotePair = vi.fn(async () => ({ deviceId: 'd1', deviceToken: 'device-token-1' }));
    setApiClientForTests(fakeApi({ remotePair }));
    const registerPasskey = vi.fn(async () => {});
    const setupPush = vi.fn(async () => 'subscribed' as const);
    renderWithClient(<PairPage registerPasskey={registerPasskey} setupPush={setupPush} />);

    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'abcd2345' } });
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
        remotePair: vi.fn(async () =>
          Promise.reject(Object.assign(new Error('wrong or expired pairing code'), { code: 'invalid_code' })),
        ),
      }),
    );
    renderWithClient(<PairPage registerPasskey={vi.fn()} setupPush={vi.fn(async () => 'denied' as const)} />);
    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'ZZZZZZZZ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }));
    expect((await screen.findByRole('alert')).textContent).toContain('wrong or expired pairing code');
    expect(readDeviceToken()).toBeNull();
  });
});
