import { createHash } from 'node:crypto';
import type { OrcConfig } from '@orc/api-contract';
import webpush from 'web-push';
import type { OrcDb } from '../db/client.ts';
import {
  deletePushSubscription,
  listPushSubscriptions,
  markPushFailure,
  markPushOk,
} from '../db/repos/remote.ts';
import { type PushPayload, pushPayload, remoteUrl } from './format.ts';
import type { NotifyChannelImpl } from './notifier.ts';
import type { VapidKeys } from './vapid.ts';

export type PushSender = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: {
    vapidDetails: { subject: string; publicKey: string; privateKey: string };
    TTL: number;
    urgency: 'high';
    topic: string;
  },
) => Promise<{ statusCode: number }>;

const ALLOWED_PUSH_HOSTS: readonly RegExp[] = [
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

const MAX_FAILURES = 5;

/** https to a known browser push service only, so a subscription cannot point the daemon at an arbitrary host. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && ALLOWED_PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export interface WebPushChannel extends NotifyChannelImpl {
  sendTest(): Promise<number>;
}

const topicFor = (tag: string) => createHash('sha256').update(tag).digest('base64url').slice(0, 32);

export function createWebPushChannel(d: {
  db: OrcDb;
  keys: VapidKeys;
  config: () => OrcConfig;
  send?: PushSender;
  log?: { warn(o: object, m?: string): void };
}): WebPushChannel {
  const sender: PushSender =
    d.send ?? ((sub, payload, options) => webpush.sendNotification(sub, payload, options));

  async function deliver(payload: PushPayload): Promise<number> {
    const cfg = d.config();
    const subject = `mailto:${cfg.remote.allowedLogin ?? 'orchestrator@example.com'}`;
    const body = JSON.stringify(payload);
    let sent = 0;
    for (const s of listPushSubscriptions(d.db)) {
      if (!isAllowedPushEndpoint(s.endpoint)) {
        deletePushSubscription(d.db, s.endpoint);
        continue;
      }
      try {
        await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
          vapidDetails: { subject, publicKey: d.keys.publicKey, privateKey: d.keys.privateKey },
          TTL: 3600,
          urgency: 'high',
          topic: topicFor(payload.tag),
        });
        markPushOk(d.db, s.endpoint, new Date().toISOString());
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: unknown }).statusCode;
        if (status === 404 || status === 410) deletePushSubscription(d.db, s.endpoint);
        else if (markPushFailure(d.db, s.endpoint) >= MAX_FAILURES) deletePushSubscription(d.db, s.endpoint);
        // Status only: a push-service error body can echo the endpoint, which is a bearer URL.
        d.log?.warn({ status }, 'web push delivery failed');
      }
    }
    return sent;
  }

  return {
    id: 'webpush',
    async send(item, url) {
      await deliver(pushPayload(item, remoteUrl(url, d.config().remote.origin)));
    },
    sendTest() {
      const cfg = d.config();
      const base = cfg.remote.origin ?? `http://127.0.0.1:${cfg.port}`;
      return deliver({
        title: 'Orchestrator',
        body: 'Test notification',
        url: `${base.replace(/\/$/, '')}/inbox`,
        tag: 'orchestrator-test',
        itemId: 'test',
      });
    },
  };
}
