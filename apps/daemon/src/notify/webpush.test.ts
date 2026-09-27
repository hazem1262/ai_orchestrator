import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempHomes } from '../../test/helpers.ts';
import { p6TestApp, send } from '../../test/p6-app.ts';
import { makeInboxItem, p6Context } from '../../test/p6-fakes.ts';
import { insertRemoteDevice, listPushSubscriptions, upsertPushSubscription } from '../db/repos/remote.ts';
import { registerPushRoutes } from '../http/routes/push.ts';
import { pushPayload, remoteUrl } from './format.ts';
import { loadOrCreateVapidKeys } from './vapid.ts';
import { createWebPushChannel, isAllowedPushEndpoint, type PushSender } from './webpush.ts';

const FCM = 'https://fcm.googleapis.com/fcm/send/abc';
const APPLE = 'https://web.push.apple.com/QABC';
const T = '2026-09-17T10:00:00.000Z';

describe('web push', () => {
  useTempHomes();
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const f of cleanups.splice(0)) f();
  });

  function setup(
    remote: Record<string, unknown> = {
      enabled: true,
      origin: 'https://mac.tail1234.ts.net',
      allowedLogin: 'me@example.com',
    },
  ) {
    const { ctx } = p6Context({ config: { remote } });
    cleanups.push(() => ctx.dispose());
    const keys = loadOrCreateVapidKeys(
      ctx.paths.orcHome,
      () => ({ publicKey: 'BPUB', privateKey: 'PRIV' }),
      () => new Date(T),
    );
    const sender = vi.fn<PushSender>(async () => ({ statusCode: 201 }));
    const channel = createWebPushChannel({ db: ctx.db, keys, config: ctx.config, send: sender });
    return { ctx, keys, sender, channel };
  }

  it('creates VAPID keys once with mode 0600', () => {
    const s = setup();
    expect(s.keys).toEqual({ publicKey: 'BPUB', privateKey: 'PRIV', createdAt: T });
    const file = join(s.ctx.paths.orcHome, 'vapid.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = loadOrCreateVapidKeys(s.ctx.paths.orcHome, () => ({
      publicKey: 'OTHER',
      privateKey: 'OTHER',
    }));
    expect(again.publicKey).toBe('BPUB');
  });

  it('formats a redacted payload with a tailnet URL', () => {
    const item = makeInboxItem({ id: 'i1', reason: 'Waiting: token=abc123 ok?' });
    expect(remoteUrl('http://127.0.0.1:4317/sessions/claude/s1?x=1', 'https://mac.tail1234.ts.net')).toBe(
      'https://mac.tail1234.ts.net/sessions/claude/s1?x=1',
    );
    expect(remoteUrl('http://127.0.0.1:4317/inbox', null)).toBe('http://127.0.0.1:4317/inbox');
    expect(pushPayload(item, 'https://x/inbox')).toMatchObject({
      body: '[wakecap] SAF-1787 · Waiting: token=«redacted:secret» ok?',
      tag: 'waiting:claude:s1',
      itemId: 'i1',
    });
  });

  it('sends to every subscription and prunes gone or failing ones', async () => {
    const s = setup();
    upsertPushSubscription(s.ctx.db, {
      deviceId: null,
      endpoint: FCM,
      p256dh: 'p1',
      auth: 'a1',
      createdAt: T,
    });
    upsertPushSubscription(s.ctx.db, {
      deviceId: null,
      endpoint: APPLE,
      p256dh: 'p2',
      auth: 'a2',
      createdAt: T,
    });
    upsertPushSubscription(s.ctx.db, {
      deviceId: null,
      endpoint: 'https://evil.example.com/push',
      p256dh: 'p3',
      auth: 'a3',
      createdAt: T,
    });
    s.sender.mockImplementation(async (sub) => {
      if (sub.endpoint === APPLE) throw Object.assign(new Error('gone'), { statusCode: 410 });
      return { statusCode: 201 };
    });
    await s.channel.send(makeInboxItem({ id: 'i1' }), 'http://127.0.0.1:4317/sessions/claude/s1');
    expect(s.sender).toHaveBeenCalledTimes(2);
    const [sub, payload, options] = s.sender.mock.calls[0] ?? [];
    expect(sub).toEqual({ endpoint: FCM, keys: { p256dh: 'p1', auth: 'a1' } });
    expect(JSON.parse(String(payload))).toMatchObject({
      title: 'Waiting for you',
      url: 'https://mac.tail1234.ts.net/sessions/claude/s1',
    });
    expect(options).toMatchObject({
      vapidDetails: { subject: 'mailto:me@example.com', publicKey: 'BPUB', privateKey: 'PRIV' },
      TTL: 3600,
      urgency: 'high',
    });
    expect(options?.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(listPushSubscriptions(s.ctx.db).map((x) => x.endpoint)).toEqual([FCM]);

    s.sender.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));
    for (let i = 0; i < 5; i++)
      await s.channel.send(makeInboxItem({ id: 'i1' }), 'http://127.0.0.1:4317/inbox');
    expect(listPushSubscriptions(s.ctx.db)).toEqual([]);
  });

  it('allows only real push service endpoints', () => {
    expect(isAllowedPushEndpoint(FCM)).toBe(true);
    expect(isAllowedPushEndpoint(APPLE)).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://127.0.0.1/x')).toBe(false);
  });

  it('manages subscriptions over HTTP', async () => {
    const s = setup();
    insertRemoteDevice(s.ctx.db, {
      id: 'd1',
      name: 'Phone',
      tokenHash: 'h',
      login: 'me@example.com',
      createdAt: T,
      lastSeenAt: null,
      revokedAt: null,
    });
    const app = p6TestApp();
    registerPushRoutes(app, s.ctx, { keys: s.keys, channel: s.channel });
    expect(await (await send(app, 'GET', '/api/push/vapid-public-key')).json()).toEqual({
      publicKey: 'BPUB',
    });
    const bad = await send(app, 'POST', '/api/push/subscriptions', {
      endpoint: 'https://evil.example.com/x',
      keys: { p256dh: 'BExampleKey1', auth: 'authsecret' },
    });
    expect(bad.status).toBe(400);
    const ok = await send(
      app,
      'POST',
      '/api/push/subscriptions',
      { endpoint: FCM, keys: { p256dh: 'BExampleKey1', auth: 'authsecret' } },
      { 'x-test-remote': 'd1' },
    );
    expect(ok.status).toBe(200);
    expect(listPushSubscriptions(s.ctx.db)[0]).toMatchObject({ endpoint: FCM, deviceId: 'd1' });
    expect(await (await send(app, 'POST', '/api/push/test', {})).json()).toEqual({ sent: 1 });
    expect((await send(app, 'DELETE', '/api/push/subscriptions', { endpoint: FCM })).status).toBe(200);
    expect(listPushSubscriptions(s.ctx.db)).toEqual([]);
  });
});
