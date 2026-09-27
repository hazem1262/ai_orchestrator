import { apiError } from '@orc/api-contract';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { useTempHomes } from '../../test/helpers.ts';
import { p6Context } from '../../test/p6-fakes.ts';
import { createDeviceService } from '../remote/devices.ts';
import { createPairingService } from '../remote/pairing.ts';
import { createStepUpStore } from '../remote/step-up.ts';
import { ServiceError } from '../services/errors.ts';
import { apiAccessMiddleware, bootstrapHandler } from './auth.ts';
import { remoteGuard, remotePolicy } from './remote-guard.ts';
import { registerRemoteRoutes } from './routes/remote.ts';
import type { OrcEnv } from './types.ts';

const INSTALL = 'f'.repeat(64);
const ORIGIN = 'https://mac.tail1234.ts.net';
const LOCAL = { host: '127.0.0.1:4317' };
const REMOTE = {
  host: '127.0.0.1:4317',
  'x-forwarded-host': 'mac.tail1234.ts.net',
  'x-forwarded-for': '100.101.102.103',
  'tailscale-user-login': 'me@example.com',
};
const ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never;
type Err = { error: { code: string } };

describe('remote guard', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function build(
    remote: Record<string, unknown> = { enabled: true, origin: ORIGIN, allowedLogin: 'me@example.com' },
  ) {
    const { ctx, audit } = p6Context({ config: { remote } });
    cleanups.push(() => ctx.dispose());
    const devices = createDeviceService(ctx.db);
    const stepUp = createStepUpStore({ ttlMs: () => 300_000 });
    const pairing = createPairingService({ ttlMs: () => 300_000 });
    let funnelOn = false;
    const funnel = {
      detected: () => funnelOn,
      refresh: async () => funnelOn,
      start: () => {},
      stop: () => {},
    };
    const app = new Hono<OrcEnv>();
    app.onError((err, c) =>
      err instanceof ServiceError
        ? c.json(apiError(err.code, err.message, err.details), err.status)
        : c.json(apiError('internal', String(err)), 500),
    );
    app.use('*', remoteGuard({ config: ctx.config, devices, stepUp, funnel }));
    app.use('/api/*', apiAccessMiddleware({ token: INSTALL, port: () => 4317 }));
    app.get('/bootstrap.js', bootstrapHandler({ token: INSTALL, port: () => 4317 }));
    registerRemoteRoutes(app, ctx, { devices, pairing, stepUp, funnel });
    app.get('/api/live', (c) => c.json([]));
    app.delete('/api/pty/:id', (c) => c.json({ killed: c.req.param('id') }));
    app.post('/api/templates/x', (c) => c.json({ wrote: true }));
    const req = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
      app.request(
        `http://127.0.0.1:4317${path}`,
        {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        ENV,
      );
    const pair = async () => {
      const { code } = (await (
        await req('POST', '/api/remote/pairing', { ...LOCAL, 'x-orc-token': INSTALL }, {})
      ).json()) as { code: string };
      const res = await req('POST', '/api/remote/pair', REMOTE, { code, name: 'Phone' });
      return (await res.json()) as { deviceId: string; deviceToken: string };
    };
    return {
      ctx,
      audit,
      req,
      pair,
      stepUp,
      setFunnel: (v: boolean) => {
        funnelOn = v;
      },
    };
  }

  it('keeps the local token rules for local requests', async () => {
    const b = build();
    expect((await b.req('GET', '/api/live', { ...LOCAL, 'x-orc-token': INSTALL })).status).toBe(200);
    expect((await b.req('GET', '/api/live', LOCAL)).status).toBe(401);
  });

  it('blocks remote requests when remote access is off or misconfigured', async () => {
    const off = build({ enabled: false });
    const res = await off.req('GET', '/api/live', REMOTE);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Err).error.code).toBe('remote_disabled');
    const b = build();
    b.setFunnel(true);
    expect(((await (await b.req('GET', '/api/live', REMOTE)).json()) as Err).error.code).toBe(
      'funnel_detected',
    );
  });

  it('checks identity, host, origin and the device token', async () => {
    const b = build();
    const code = async (headers: Record<string, string>) =>
      ((await (await b.req('GET', '/api/live', headers)).json()) as Err).error.code;
    expect(await code({ ...REMOTE, 'tailscale-user-login': 'someone@example.com' })).toBe(
      'remote_identity_mismatch',
    );
    expect(await code({ ...REMOTE, 'x-forwarded-host': 'evil.example.com' })).toBe('remote_bad_host');
    expect(await code({ ...REMOTE, origin: 'https://evil.example.com' })).toBe('forbidden');
    expect(await code(REMOTE)).toBe('unauthorized');
    expect(await code({ ...REMOTE, 'x-orc-token': INSTALL })).toBe('unauthorized');
  });

  it('pairs a device, then allows reads and denies loopback-only routes', async () => {
    const b = build();
    const { deviceId, deviceToken } = await b.pair();
    expect(deviceToken.length).toBeGreaterThanOrEqual(43);
    expect(b.audit.list({ action: 'remote.pair' })[0]).toMatchObject({
      actor: 'remote',
      target: deviceId,
      result: 'ok',
    });
    expect((await b.req('GET', '/api/live', { ...REMOTE, 'x-orc-token': deviceToken })).status).toBe(200);
    const devices = await b.req('GET', '/api/remote/devices', { ...REMOTE, 'x-orc-token': deviceToken });
    expect(((await devices.json()) as Err).error.code).toBe('remote_forbidden');
    const listed = (await (
      await b.req('GET', '/api/remote/devices', { ...LOCAL, 'x-orc-token': INSTALL })
    ).json()) as Array<Record<string, unknown>>;
    expect(listed[0]).toMatchObject({ id: deviceId, name: 'Phone', login: 'me@example.com', credentials: 0 });
    expect(listed[0]).not.toHaveProperty('tokenHash');
    const write = await b.req('POST', '/api/templates/x', { ...REMOTE, 'x-orc-token': deviceToken }, {});
    expect(((await write.json()) as Err).error.code).toBe('remote_forbidden');
  });

  it('requires step-up for state-changing remote routes', async () => {
    const b = build();
    const { deviceId, deviceToken } = await b.pair();
    const first = await b.req('DELETE', '/api/pty/p1', { ...REMOTE, 'x-orc-token': deviceToken });
    expect(first.status).toBe(401);
    expect(((await first.json()) as Err).error.code).toBe('step_up_required');
    b.stepUp.grant(deviceId);
    expect((await b.req('DELETE', '/api/pty/p1', { ...REMOTE, 'x-orc-token': deviceToken })).status).toBe(
      200,
    );
  });

  it('rejects bad pairing attempts', async () => {
    const b = build();
    await b.req('POST', '/api/remote/pairing', { ...LOCAL, 'x-orc-token': INSTALL }, {});
    const wrong = await b.req('POST', '/api/remote/pair', REMOTE, { code: 'ZZZZZZZZ', name: 'Phone' });
    expect(((await wrong.json()) as Err).error.code).toBe('invalid_code');
    expect(b.audit.list({ action: 'remote.pair' })[0]?.result).toBe('denied');
    const local = await b.req(
      'POST',
      '/api/remote/pair',
      { ...LOCAL, 'x-orc-token': INSTALL },
      { code: 'ZZZZZZZZ', name: 'Mac' },
    );
    expect(((await local.json()) as Err).error.code).toBe('not_remote');
    const remotePairing = await b.req('POST', '/api/remote/pairing', REMOTE, {});
    expect(((await remotePairing.json()) as Err).error.code).toBe('remote_forbidden');
  });

  it('revokes devices from the Mac', async () => {
    const b = build();
    const { deviceId, deviceToken } = await b.pair();
    expect(
      (await b.req('DELETE', `/api/remote/devices/${deviceId}`, { ...LOCAL, 'x-orc-token': INSTALL }, {}))
        .status,
    ).toBe(409);
    expect(
      (
        await b.req(
          'DELETE',
          `/api/remote/devices/${deviceId}`,
          { ...LOCAL, 'x-orc-token': INSTALL },
          { confirm: true },
        )
      ).status,
    ).toBe(200);
    expect((await b.req('GET', '/api/live', { ...REMOTE, 'x-orc-token': deviceToken })).status).toBe(401);
  });

  it('never hands the install token to remote requests', async () => {
    const b = build();
    const local = await b.req('GET', '/bootstrap.js', LOCAL);
    expect(await local.text()).toBe(`window.__ORC_TOKEN__ = "${INSTALL}";\n`);
    const remote = await b.req('GET', '/bootstrap.js', REMOTE);
    expect(remote.status).toBe(200);
    expect(await remote.text()).toBe('window.__ORC_TOKEN__ = null;\n');
  });

  it('saves the remote config from the Mac and reports status', async () => {
    const b = build({ enabled: false });
    const res = await b.req(
      'POST',
      '/api/remote/config',
      { ...LOCAL, 'x-orc-token': INSTALL },
      { enabled: true, origin: ORIGIN, allowedLogin: 'me@example.com' },
    );
    expect(await res.json()).toMatchObject({
      enabled: true,
      origin: ORIGIN,
      isRemote: false,
      funnelDetected: false,
    });
    expect(b.ctx.config().remote.enabled).toBe(true);
    const bad = await b.req(
      'POST',
      '/api/remote/config',
      { ...LOCAL, 'x-orc-token': INSTALL },
      { enabled: true, origin: null, allowedLogin: null },
    );
    expect(bad.status).toBe(400);
  });

  it('classifies routes', () => {
    expect(remotePolicy('GET', '/api/inbox')).toBe('device');
    expect(remotePolicy('POST', '/api/sessions/claude/s1/reply')).toBe('stepup');
    expect(remotePolicy('POST', '/api/sessions/claude/s1/plan/approve')).toBe('stepup');
    expect(remotePolicy('POST', '/api/ship/merge')).toBe('stepup');
    expect(remotePolicy('POST', '/api/inbox/i1/snooze')).toBe('device');
    expect(remotePolicy('POST', '/api/sessions/launch')).toBe('deny');
    expect(remotePolicy('GET', '/api/sessions/claude/s1/export')).toBe('deny');
    expect(remotePolicy('GET', '/assets/index.js')).toBe('public');
    expect(remotePolicy('GET', '/pty/abc')).toBe('deny');
    expect(remotePolicy('GET', '/ws')).toBe('device');
  });
});
