import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempHomes } from '../../test/helpers.ts';
import { p6TestApp, send } from '../../test/p6-app.ts';
import { p6Context } from '../../test/p6-fakes.ts';
import { getWebauthnCredential } from '../db/repos/remote.ts';
import { registerWebAuthnRoutes } from '../http/routes/webauthn.ts';
import { createDeviceService } from './devices.ts';
import { createStepUpStore } from './step-up.ts';
import { createWebAuthnService, type WebAuthnLib } from './webauthn.ts';

type RegOpts = Parameters<WebAuthnLib['generateRegistrationOptions']>[0];
type RegVerify = Parameters<WebAuthnLib['verifyRegistrationResponse']>[0];
type AuthOpts = Parameters<WebAuthnLib['generateAuthenticationOptions']>[0];
type AuthVerify = Parameters<WebAuthnLib['verifyAuthenticationResponse']>[0];
type Err = { error: { code: string } };

function fakeLib() {
  const regOpts = vi.fn(async (o: RegOpts) => ({
    challenge: 'reg-chal',
    rp: { name: o.rpName, id: o.rpID },
    user: { id: 'dXNlcg', name: o.userName, displayName: o.userName },
    pubKeyCredParams: [],
  }));
  const regVerify = vi.fn(async (_o: RegVerify) => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: 'cred-1',
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ['internal'],
      },
    },
  }));
  const authOpts = vi.fn(async (o: AuthOpts) => ({
    challenge: 'auth-chal',
    rpId: o.rpID,
    allowCredentials: o.allowCredentials,
  }));
  const authVerify = vi.fn(async (_o: AuthVerify) => ({
    verified: true,
    authenticationInfo: { newCounter: 7 },
  }));
  const lib = {
    generateRegistrationOptions: regOpts,
    verifyRegistrationResponse: regVerify,
    generateAuthenticationOptions: authOpts,
    verifyAuthenticationResponse: authVerify,
  } as unknown as WebAuthnLib;
  return { lib, regOpts, regVerify, authOpts, authVerify };
}

describe('webauthn', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function build(o: { enabled?: boolean } = {}) {
    const { ctx, audit } = p6Context({
      config: {
        remote: {
          enabled: o.enabled ?? true,
          origin: 'https://mac.tail1234.ts.net',
          allowedLogin: 'me@example.com',
        },
      },
    });
    cleanups.push(() => ctx.dispose());
    let now = Date.parse('2026-09-17T10:00:00.000Z');
    const devices = createDeviceService(ctx.db, { now: () => new Date(now) });
    const stepUp = createStepUpStore({ ttlMs: () => 300_000, now: () => now });
    const f = fakeLib();
    const webauthn = createWebAuthnService({
      db: ctx.db,
      config: ctx.config,
      devices,
      stepUp,
      lib: f.lib,
      now: () => now,
    });
    const app = p6TestApp();
    registerWebAuthnRoutes(app, ctx, { webauthn });
    const { device } = devices.create('Phone', 'me@example.com');
    const other = devices.create('Tablet', 'me@example.com').device;
    const as = (id: string) => ({ 'x-test-remote': id });
    return {
      ctx,
      audit,
      app,
      device,
      other,
      stepUp,
      f,
      as,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('registers one passkey for a freshly paired device', async () => {
    const b = build();
    const opts = await send(b.app, 'POST', '/api/webauthn/register/options', {}, b.as(b.device.id));
    expect(await opts.json()).toMatchObject({ challenge: 'reg-chal', rp: { id: 'mac.tail1234.ts.net' } });
    expect(b.f.regOpts.mock.calls[0]?.[0]).toMatchObject({
      rpID: 'mac.tail1234.ts.net',
      userName: 'me@example.com',
      attestationType: 'none',
    });
    const ok = await send(
      b.app,
      'POST',
      '/api/webauthn/register/verify',
      { response: { id: 'cred-1' } },
      b.as(b.device.id),
    );
    expect(await ok.json()).toEqual({ credentialId: 'cred-1' });
    expect(b.f.regVerify.mock.calls[0]?.[0]).toMatchObject({
      expectedChallenge: 'reg-chal',
      expectedOrigin: 'https://mac.tail1234.ts.net',
      expectedRPID: 'mac.tail1234.ts.net',
      requireUserVerification: true,
    });
    expect(getWebauthnCredential(b.ctx.db, 'cred-1')).toMatchObject({
      deviceId: b.device.id,
      publicKey: 'AQID',
      transports: ['internal'],
    });
    expect(b.audit.list({ action: 'webauthn.register' })[0]).toMatchObject({ actor: 'remote', result: 'ok' });

    const again = await send(b.app, 'POST', '/api/webauthn/register/options', {}, b.as(b.device.id));
    expect(((await again.json()) as Err).error.code).toBe('registration_window_closed');
  });

  it('closes registration 15 minutes after pairing and rejects replays', async () => {
    const b = build();
    const replay = await send(
      b.app,
      'POST',
      '/api/webauthn/register/verify',
      { response: { id: 'x' } },
      b.as(b.device.id),
    );
    expect(((await replay.json()) as Err).error.code).toBe('invalid_state');
    b.advance(15 * 60_000 + 1);
    const late = await send(b.app, 'POST', '/api/webauthn/register/options', {}, b.as(b.other.id));
    expect(((await late.json()) as Err).error.code).toBe('registration_window_closed');
  });

  it('grants a step-up for the device’s own passkey only', async () => {
    const b = build();
    await send(b.app, 'POST', '/api/webauthn/register/options', {}, b.as(b.device.id));
    await send(
      b.app,
      'POST',
      '/api/webauthn/register/verify',
      { response: { id: 'cred-1' } },
      b.as(b.device.id),
    );

    const opts = await send(b.app, 'POST', '/api/webauthn/stepup/options', {}, b.as(b.device.id));
    expect(await opts.json()).toMatchObject({
      challenge: 'auth-chal',
      allowCredentials: [{ id: 'cred-1', transports: ['internal'] }],
    });
    const ok = await send(
      b.app,
      'POST',
      '/api/webauthn/stepup/verify',
      { response: { id: 'cred-1' } },
      b.as(b.device.id),
    );
    expect(await ok.json()).toEqual({ validUntil: '2026-09-17T10:05:00.000Z' });
    expect(b.stepUp.valid(b.device.id)).toBe(true);
    expect(getWebauthnCredential(b.ctx.db, 'cred-1')?.counter).toBe(7);
    expect(b.f.authVerify.mock.calls[0]?.[0]).toMatchObject({
      expectedChallenge: 'auth-chal',
      expectedRPID: 'mac.tail1234.ts.net',
      credential: { id: 'cred-1', counter: 0 },
    });

    const noCreds = await send(b.app, 'POST', '/api/webauthn/stepup/options', {}, b.as(b.other.id));
    expect(((await noCreds.json()) as Err).error.code).toBe('unknown_credential');
    b.f.authOpts.mockClear();
    await send(b.app, 'POST', '/api/webauthn/stepup/options', {}, b.as(b.device.id));
    const foreign = await send(
      b.app,
      'POST',
      '/api/webauthn/stepup/verify',
      { response: { id: 'cred-of-someone' } },
      b.as(b.device.id),
    );
    expect(((await foreign.json()) as Err).error.code).toBe('unknown_credential');
  });

  it('refuses local callers and disabled remote access', async () => {
    const b = build();
    const local = await send(b.app, 'POST', '/api/webauthn/stepup/options', {});
    expect(((await local.json()) as Err).error.code).toBe('remote_only');
    const off = build({ enabled: false });
    const res = await send(off.app, 'POST', '/api/webauthn/register/options', {}, off.as(off.device.id));
    expect(((await res.json()) as Err).error.code).toBe('remote_disabled');
  });
});
