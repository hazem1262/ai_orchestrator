import type { LiveEvent } from '@orc/api-contract';
import type { Session, Source } from '@orc/core';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getToken } from './client.ts';
import { applyP3LiveEvent } from './live-p3.ts';
import { inboxRootKey, upsertInboxItemInCache } from './queries/inbox.ts';
import { liveKey } from './queries/live.ts';

/** The frames `/ws` sends (`packages/api-contract/src/live.ts`, daemon `http/live-ws.ts`). */
export type WireEvent = LiveEvent;

/** The daemon's primary key for a session, as `session.removed` carries it. */
export const pkOf = (s: { source: Source; id: string }): string => `${s.source}:${s.id}`;

/**
 * Folds one live frame into the query cache. A cache that was never fetched is left absent
 * rather than created, so a socket frame can't seed a list the UI has not asked for yet.
 */
export function applyLiveEvent(qc: QueryClient, e: WireEvent): void {
  applyP2LiveEvent(qc, e);
  applyP3LiveEvent(qc, e);
}

function applyP2LiveEvent(qc: QueryClient, e: WireEvent): void {
  switch (e.type) {
    case 'hello':
      // Sent on first connect and on every reconnect: refetch rather than replay the gap.
      void qc.invalidateQueries({ queryKey: liveKey });
      void qc.invalidateQueries({ queryKey: inboxRootKey });
      return;
    case 'session.updated': {
      const s = e.session;
      const pk = pkOf(s);
      qc.setQueryData<Session[]>(liveKey, (old) => {
        if (!old) return old;
        if (!s.live) return old.filter((x) => pkOf(x) !== pk);
        const idx = old.findIndex((x) => pkOf(x) === pk);
        if (idx === -1) return [...old, s];
        const next = old.slice();
        next[idx] = s;
        return next;
      });
      qc.setQueryData<Session>(['session', s.source, s.id], (old) => (old ? { ...old, ...s } : old));
      return;
    }
    case 'session.removed':
      qc.setQueryData<Session[]>(liveKey, (old) => old?.filter((x) => pkOf(x) !== e.pk));
      return;
    case 'inbox.upserted':
      upsertInboxItemInCache(qc, e.item);
      return;
    case 'pty.exited':
      void qc.invalidateQueries({ queryKey: liveKey });
      return;
    default:
      // `index.progress`, `usage.updated` and anything a newer daemon adds.
      return;
  }
}

export function liveWsUrl(loc: Pick<Location, 'protocol' | 'host'>, token: string): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/ws?token=${encodeURIComponent(token)}`;
}

export function useLiveEvents(opts: { url?: string; WebSocketImpl?: typeof WebSocket } = {}): {
  connected: boolean;
} {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const { url, WebSocketImpl } = opts;

  useEffect(() => {
    const Impl = WebSocketImpl ?? WebSocket;
    const target = url ?? liveWsUrl(window.location, getToken());
    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      ws = new Impl(target);
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (m) => {
        try {
          applyLiveEvent(qc, JSON.parse(String(m.data)) as WireEvent);
        } catch {
          // A malformed frame is dropped; the next `hello` resyncs the caches.
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (disposed) return;
        const delay = Math.min(30_000, 500 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [qc, url, WebSocketImpl]);

  return { connected };
}
