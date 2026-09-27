import { PushSubscriptionBody, PushUnsubscribeBody } from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { deletePushSubscription, upsertPushSubscription } from '../../db/repos/remote.ts';
import type { VapidKeys } from '../../notify/vapid.ts';
import { isAllowedPushEndpoint, type WebPushChannel } from '../../notify/webpush.ts';
import { ServiceError } from '../../services/errors.ts';
import { readJson } from '../json.ts';
import { remoteOf } from '../p6-util.ts';
import type { OrcApp } from '../types.ts';

/**
 * VAPID public key, push subscriptions and a test send. A remote subscription stores the calling
 * device id, so revoking the device drops it. Not mounted by `registerAllRoutes` yet: Task 20's
 * `createPhase6().register` mounts it with the other Phase 6 routes.
 */
export function registerPushRoutes(
  app: OrcApp,
  ctx: DaemonContext,
  d: { keys: VapidKeys; channel: WebPushChannel },
): void {
  app.get('/api/push/vapid-public-key', (c) => c.json({ publicKey: d.keys.publicKey }));

  app.post('/api/push/subscriptions', async (c) => {
    const body = await readJson(c, PushSubscriptionBody);
    if (!isAllowedPushEndpoint(body.endpoint)) {
      throw new ServiceError('bad_push_endpoint', 400, 'unsupported push service endpoint');
    }
    upsertPushSubscription(ctx.db, {
      deviceId: remoteOf(c)?.deviceId ?? null,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      createdAt: new Date().toISOString(),
    });
    return c.json({ ok: true as const });
  });

  app.delete('/api/push/subscriptions', async (c) => {
    const { endpoint } = await readJson(c, PushUnsubscribeBody);
    deletePushSubscription(ctx.db, endpoint);
    return c.json({ ok: true as const });
  });

  app.post('/api/push/test', async (c) => c.json({ sent: await d.channel.sendTest() }));
}
