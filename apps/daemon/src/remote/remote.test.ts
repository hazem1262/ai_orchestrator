import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OrcDb, openDb } from '../db/client.ts';
import { hostnameOf, isRemoteRequest, loginMatches } from './classify.ts';
import { createDeviceService, hashToken } from './devices.ts';
import { createPairingService, PAIRING_ALPHABET } from './pairing.ts';
import { createStepUpStore } from './step-up.ts';
import { createFunnelWatch, detectFunnel } from './tailscale.ts';

const h = (headers: Record<string, string>) => (name: string) => headers[name.toLowerCase()];

describe('classify', () => {
  it('treats serve-proxied requests as remote even from 127.0.0.1', () => {
    expect(isRemoteRequest(h({ host: '127.0.0.1:4317' }), '127.0.0.1')).toBe(false);
    expect(isRemoteRequest(h({ host: 'localhost:4317' }), '::1')).toBe(false);
    expect(
      isRemoteRequest(h({ host: '127.0.0.1:4317', 'tailscale-user-login': 'me@example.com' }), '127.0.0.1'),
    ).toBe(true);
    expect(isRemoteRequest(h({ host: '127.0.0.1:4317', 'x-forwarded-for': '100.64.0.2' }), '127.0.0.1')).toBe(
      true,
    );
    expect(isRemoteRequest(h({ host: 'mac.tail1234.ts.net' }), '127.0.0.1')).toBe(true);
    expect(isRemoteRequest(h({ host: '127.0.0.1:4317' }), '100.64.0.2')).toBe(true);
    expect(isRemoteRequest(h({}), null)).toBe(false);
  });

  it('parses hosts and compares logins', () => {
    expect(hostnameOf('mac.tail1234.ts.net:443')).toBe('mac.tail1234.ts.net');
    expect(hostnameOf('[::1]:4317')).toBe('[::1]');
    expect(hostnameOf('a b')).toBeNull();
    expect(loginMatches(' Me@Example.com ', 'me@example.com')).toBe(true);
    expect(loginMatches('', 'me@example.com')).toBe(false);
    expect(loginMatches('me@example.com', null)).toBe(false);
  });
});

describe('pairing', () => {
  it('issues single-use codes that expire and lock after failures', () => {
    let now = 0;
    const p = createPairingService({ ttlMs: () => 1000, maxFailures: 3, now: () => now });
    const { code } = p.create();
    expect(code).toMatch(new RegExp(`^[${PAIRING_ALPHABET}]{8}$`));
    expect(p.consume(code.toLowerCase())).toBe(true);
    expect(p.consume(code)).toBe(false);

    const second = p.create().code;
    now = 1001;
    expect(p.consume(second)).toBe(false);

    now = 2000;
    const third = p.create().code;
    expect(p.activeUntil()).toBe(new Date(3000).toISOString());
    expect(p.consume('AAAAAAAA')).toBe(false);
    expect(p.consume('BBBBBBBB')).toBe(false);
    expect(p.consume('CCCCCCCC')).toBe(false);
    expect(p.consume(third)).toBe(false);
    expect(p.activeUntil()).toBeNull();
  });
});

describe('step-up', () => {
  it('grants per device until the TTL passes', () => {
    let now = 0;
    const s = createStepUpStore({ ttlMs: () => 300_000, now: () => now });
    expect(s.valid('d1')).toBe(false);
    expect(s.grant('d1')).toBe(new Date(300_000).toISOString());
    expect(s.valid('d1')).toBe(true);
    expect(s.valid('d2')).toBe(false);
    now = 300_001;
    expect(s.valid('d1')).toBe(false);
    expect(s.validUntil('d1')).toBeNull();
    s.grant('d1');
    s.revoke('d1');
    expect(s.valid('d1')).toBe(false);
  });
});

describe('devices', () => {
  let dir: string;
  let db: OrcDb;
  let close: () => void;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'p6-devices-'));
    ({ db, close } = openDb(join(dir, 'index.db')));
  });
  afterEach(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('verifies hashed tokens and rejects revoked or foreign ones', () => {
    const devices = createDeviceService(db);
    const { device, token } = devices.create('Phone', 'me@example.com');
    expect(device.tokenHash).toBe(hashToken(token));
    expect(device.tokenHash).not.toContain(token);
    expect(devices.verify(token)?.id).toBe(device.id);
    expect(devices.verify(null)).toBeNull();
    expect(devices.verify('short')).toBeNull();
    expect(devices.verify('a'.repeat(64))).toBeNull();
    expect(devices.list()[0]).toMatchObject({ id: device.id, credentials: 0 });
    expect(devices.revoke(device.id)).toBe(true);
    expect(devices.verify(token)).toBeNull();
  });
});

describe('tailscale funnel detection', () => {
  it('reads AllowFunnel from serve status', async () => {
    expect(detectFunnel({ TCP: { '443': { HTTPS: true } } })).toBe(false);
    expect(detectFunnel({ AllowFunnel: { 'mac.tail1234.ts.net:443': true } })).toBe(true);
    expect(detectFunnel(null)).toBe(false);
    let json = '{"AllowFunnel":{"mac.tail1234.ts.net:443":true}}';
    const watch = createFunnelWatch({ run: async () => json });
    expect(await watch.refresh()).toBe(true);
    expect(watch.detected()).toBe(true);
    json = '{}';
    expect(await watch.refresh()).toBe(false);
    const missing = createFunnelWatch({
      run: async () => {
        throw new Error('spawn tailscale ENOENT');
      },
    });
    expect(await missing.refresh()).toBe(false);
  });
});
