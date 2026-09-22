import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { DaemonContext } from '../context.ts';
import type { BusEvent } from '../live/event-bus.ts';
import { tokenMatches } from './auth.ts';
import { redactInboxItem, redactSession, redactValue } from './redact-out.ts';

/** The bus events that are fanned out to browsers. Everything else on the bus stays internal. */
export const LIVE_EVENT_TYPES = [
  'session.updated',
  'session.removed',
  'inbox.upserted',
  'pty.exited',
  'index.progress',
  'usage.updated',
] as const;
type LiveType = (typeof LIVE_EVENT_TYPES)[number];
export type WireEvent = Extract<BusEvent, { type: LiveType }> | { type: 'hello'; serverTime: string };

export interface LiveWsHub {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  clientCount(): number;
  close(): Promise<void>;
}

export interface LiveWsHubOptions {
  /**
   * Required, not optional-with-a-default: this socket carries the same live session data as
   * `GET /api/live`, and a hub that could be constructed without a token would eventually be.
   */
  token: string;
  origins: () => string[];
  now?: () => Date;
  maxBufferedBytes?: number;
}

export const LIVE_WS_PATH = '/ws';

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * The `/ws` fan-out hub, a sibling of `http/ws.ts`'s `/pty/:ptyId` socket and deliberately not a
 * change to it. It reuses that socket's proven guards — header-or-query token, allow-listed
 * Origin, a 1 MiB frame cap, and an `error` listener on the server, the pre-upgrade socket and
 * every connection — because a second socket with weaker auth than the first is the whole risk.
 *
 * Everything that leaves here goes through `redact-out.ts`, the same boundary the HTTP routes
 * use. `toWire` is an exhaustive switch on purpose: adding a type to `LIVE_EVENT_TYPES` without
 * deciding how it is redacted is a compile error, not a silent passthrough.
 *
 * NOT YET CONSTRUCTED IN PRODUCTION. `http/ws.ts` owns the server's only `upgrade` listener today
 * and destroys any socket that is not `/pty/:ptyId`, so a second listener cannot simply be added
 * alongside it — the pty one would destroy a `/ws` socket the moment after this hub upgraded it.
 * Task 16 owns that dispatch (`attachWebSockets(server, ctx, { liveHub })`); it must route by
 * `LIVE_WS_PATH` before calling either, and pass the daemon's token and `allowedOrigins(port)`.
 */
export function createLiveWsHub(ctx: DaemonContext, opts: LiveWsHubOptions): LiveWsHub {
  const now = opts.now ?? (() => new Date());
  const maxBuffered = opts.maxBufferedBytes ?? 5 * 1024 * 1024;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  // A server-level emit (a malformed upgrade the ws lib itself chokes on) must not be an
  // unhandled 'error' event — Node treats that as fatal and kills the whole daemon process.
  wss.on('error', (err) => ctx.log.warn({ err }, 'live websocket server error'));

  wss.on('connection', (ws: WebSocket) => {
    // Registered before the first frame can flow. A client frame over `maxPayload` is rejected by
    // the Receiver before any 'message' handler could run, and an unhandled 'error' event on a
    // socket is fatal to the whole Node process — one bad client must only lose its own
    // connection. Listening is the load-bearing part; this handler deliberately does NOT also
    // `terminate()`, because `ws` has already begun a 1009 ("message too big") close and
    // destroying the socket here pre-empts that frame, leaving the client with a bare 1006 and no
    // idea why. Measured both ways against a 2 MiB frame: with `terminate()` the client observes
    // 1006, without it 1009, and the server drops the client either way.
    ws.on('error', (err) => ctx.log.warn({ err }, 'live websocket error'));
    const hello: WireEvent = { type: 'hello', serverTime: now().toISOString() };
    ws.send(JSON.stringify(hello));
  });

  function toWire(e: Extract<BusEvent, { type: LiveType }>): WireEvent {
    switch (e.type) {
      case 'session.updated':
        return { type: 'session.updated', session: redactSession(e.session) };
      case 'inbox.upserted':
        // `reason` is built from whatever made the session need attention, and `payload` is open.
        return { type: 'inbox.upserted', item: redactInboxItem(e.item) };
      case 'usage.updated':
        return { type: 'usage.updated', snapshot: redactValue(e.snapshot) };
      // Ids and counters only.
      case 'session.removed':
      case 'pty.exited':
      case 'index.progress':
        return e;
      default: {
        const unhandled: never = e;
        return unhandled;
      }
    }
  }

  function broadcast(e: Extract<BusEvent, { type: LiveType }>): void {
    // The tracker emits `session.updated` on every sweep that changes anything; with no browser
    // attached there is nothing to redact or serialize for.
    if (wss.clients.size === 0) return;
    const msg = JSON.stringify(toWire(e));
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > maxBuffered) {
        // A client that has stopped reading would otherwise grow the daemon's heap without bound.
        // Dropping it is safe: the UI refetches `GET /api/live` after `hello` on reconnect, so it
        // resyncs rather than replaying whatever it missed.
        client.terminate();
        continue;
      }
      client.send(msg);
    }
  }

  const unsubs = LIVE_EVENT_TYPES.map((t) => ctx.bus.on(t, (e) => broadcast(e)));

  return {
    handleUpgrade(req, socket, head) {
      // The raw pre-upgrade socket is an EventEmitter too, and can emit 'error' (a client that
      // resets before the handshake finishes) with nothing else listening.
      socket.on('error', (err) => ctx.log.warn({ err }, 'live upgrade socket error'));
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== LIVE_WS_PATH) {
        socket.destroy();
        return;
      }
      const headerToken = req.headers['x-orc-token'];
      const token = (typeof headerToken === 'string' ? headerToken : null) ?? url.searchParams.get('token');
      if (!tokenMatches(opts.token, token)) {
        reject(socket, 401, 'Unauthorized');
        return;
      }
      const origin = req.headers.origin;
      if (!origin || !opts.origins().includes(origin)) {
        reject(socket, 403, 'Forbidden');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    clientCount: () => [...wss.clients].filter((c) => c.readyState === WebSocket.OPEN).length,
    async close() {
      for (const u of unsubs) u();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
