/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { parsePushPayload } from './pwa/push-payload.ts';

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};
const sw = self;

// Static build assets only: no /api responses and no transcript text are ever cached.
// `self.__WB_MANIFEST` must stay literal: the build replaces it with the precache list.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

sw.addEventListener('install', () => {
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener('push', (event) => {
  const message = parsePushPayload(event.data ? event.data.text() : null);
  event.waitUntil(
    sw.registration.showNotification(message.title, {
      body: message.body,
      tag: message.tag,
      data: { url: message.url },
      icon: '/icons/pwa-192x192.png',
      badge: '/icons/pwa-64x64.png',
    }),
  );
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | null)?.url ?? '/inbox';
  event.waitUntil(
    (async () => {
      const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = clients[0];
      if (client) {
        await client.focus();
        await client.navigate(target);
        return;
      }
      await sw.clients.openWindow(target);
    })(),
  );
});
