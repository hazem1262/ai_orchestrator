import type { IncomingMessage } from 'node:http';
import { OrcConfig } from '@orc/api-contract';
import { describe, expect, it } from 'vitest';
import type { DeviceService } from '../remote/devices.ts';
import { createStepUpStore } from '../remote/step-up.ts';
import { checkWsUpgrade } from './ws-remote.ts';

const cfg = OrcConfig.parse({
  remote: { enabled: true, origin: 'https://mac.tail1234.ts.net', allowedLogin: 'me@example.com' },
});
const devices = {
  verify: (t: string | null | undefined) =>
    t === 'device-token-0123456789012345678901234567890'
      ? {
          id: 'd1',
          name: 'Phone',
          tokenHash: 'h',
          login: 'me@example.com',
          createdAt: '',
          lastSeenAt: null,
          revokedAt: null,
        }
      : null,
} as unknown as DeviceService;
const deps = {
  config: () => cfg,
  devices,
  stepUp: createStepUpStore({ ttlMs: () => 1000 }),
  funnel: { detected: () => false },
};
const upgrade = (url: string, headers: Record<string, string>) =>
  ({ url, headers, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
const remoteHeaders = {
  host: '127.0.0.1:4317',
  'x-forwarded-host': 'mac.tail1234.ts.net',
  'tailscale-user-login': 'me@example.com',
  origin: 'https://mac.tail1234.ts.net',
};

describe('checkWsUpgrade', () => {
  it('passes local upgrades through to the existing checks', () => {
    expect(
      checkWsUpgrade(
        upgrade('/ws?token=x', { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' }),
        deps,
      ),
    ).toEqual({ ok: true, remote: null });
    expect(checkWsUpgrade(upgrade('/ws', remoteHeaders), null)).toEqual({ ok: true, remote: null });
  });

  it('allows /ws for paired devices and refuses remote terminals', () => {
    expect(
      checkWsUpgrade(upgrade('/ws?token=device-token-0123456789012345678901234567890', remoteHeaders), deps),
    ).toEqual({
      ok: true,
      remote: { deviceId: 'd1', deviceName: 'Phone', login: 'me@example.com' },
    });
    expect(
      checkWsUpgrade(
        upgrade('/pty/abc?token=device-token-0123456789012345678901234567890', remoteHeaders),
        deps,
      ),
    ).toMatchObject({
      ok: false,
      status: 403,
      code: 'remote_forbidden',
    });
    expect(checkWsUpgrade(upgrade('/ws', remoteHeaders), deps)).toMatchObject({ ok: false, status: 401 });
    expect(
      checkWsUpgrade(
        upgrade('/ws?token=device-token-0123456789012345678901234567890', {
          ...remoteHeaders,
          origin: 'https://evil.example.com',
        }),
        deps,
      ),
    ).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });
});
