import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect as netConnect, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import type { InboxItem } from '@orc/core';
import { type Logger, pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createTestContext, type TestContext, useTempHomes } from '../../test/helpers.ts';
import type { BusEvent, EventBus } from '../live/event-bus.ts';
import { stubSession } from '../live/stub-session.ts';
import { createLiveWsHub, LIVE_EVENT_TYPES, type LiveWsHub } from './live-ws.ts';

const homes = useTempHomes();

const TOKEN = 'test-token';
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
let ctx: TestContext;
let hub: LiveWsHub;
let server: Server;
let origin: string;
let url: string;
const sockets: WebSocket[] = [];
const rawClients: Socket[] = [];
let warnings: unknown[][] = [];

/** The hub's only observable reaction to a socket-level error is a `ctx.log.warn`. */
function recordingLog(sink: unknown[][]): Logger {
  const base = pino({ level: 'silent' });
  return Object.assign(Object.create(base) as Logger, {
    warn: (...args: unknown[]) => {
      sink.push(args);
    },
  });
}

function boot(opts: { maxBufferedBytes?: number } = {}): Promise<void> {
  warnings = [];
  ctx = createTestContext({ homes, log: recordingLog(warnings) });
  hub = createLiveWsHub(ctx, {
    token: TOKEN,
    origins: () => [origin],
    now: () => new Date('2026-09-01T09:00:00.000Z'),
    ...opts,
  });
  server = createServer();
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  return new Promise<void>((r) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      origin = `http://127.0.0.1:${port}`;
      url = `ws://127.0.0.1:${port}/ws`;
      r();
    }),
  );
}

beforeEach(async () => {
  // `origins` is read lazily, so the placeholder is replaced before the first upgrade.
  origin = 'http://127.0.0.1:0';
  await boot();
});

afterEach(async () => {
  for (const c of rawClients.splice(0)) c.destroy();
  for (const ws of sockets.splice(0)) ws.terminate();
  await hub.close();
  await new Promise((r) => server.close(r));
  ctx.dispose();
});

/** `o = null` means "send no Origin header at all", which must be refused like a foreign one. */
function connect(path = `/ws?token=${TOKEN}`, o: string | null = origin): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      ...(o === null ? {} : { origin: o }),
    });
    sockets.push(ws);
    const messages: unknown[] = [];
    const closes: Array<{ code: number }> = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d))));
    ws.on('close', (code) => closes.push({ code }));
    ws.on('open', () => resolve({ ws, messages, closes }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

interface Client {
  ws: WebSocket;
  messages: unknown[];
  closes: Array<{ code: number }>;
}

const liveSession = (over: { lastPrompt?: string } = {}) => ({
  ...stubSession({ source: 'claude', id: 'x', cwd: '/w', startedAt: 't', projectId: null, name: null }),
  ...over,
});

const inboxItem = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'i1',
  kind: 'waiting',
  sessionId: 'claude:x',
  projectId: null,
  ticket: null,
  reason: 'needs input',
  dedupeKey: 'waiting:claude:x',
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-09-01T09:00:00.000Z',
  state: 'open',
  snoozeUntil: null,
  payload: {},
  ...over,
});

describe('live WS hub', () => {
  it('sends hello, then forwards live events (redacted) but not internal ones', async () => {
    const { ws, messages } = await connect();
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toEqual({ type: 'hello', serverTime: '2026-09-01T09:00:00.000Z' });
    const s = liveSession({ lastPrompt: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAA' });
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:x', from: null, to: 'busy' });
    ctx.bus.emit({ type: 'session.updated', session: s });
    ctx.bus.emit({ type: 'session.removed', pk: 'claude:x' });
    await expect.poll(() => messages.length).toBe(3);
    expect(messages[1]).toMatchObject({
      type: 'session.updated',
      session: { id: 'x', lastPrompt: '«redacted:anthropic»' },
    });
    expect(messages[2]).toEqual({ type: 'session.removed', pk: 'claude:x' });
    expect(hub.clientCount()).toBe(1);
    ws.close();
    await expect.poll(() => hub.clientCount()).toBe(0);
  });

  it('forwards every LIVE_EVENT_TYPE and nothing internal, with no raw secret on the wire', async () => {
    const { messages } = await connect();
    await expect.poll(() => messages.length).toBe(1);
    // `Record<LiveType, ...>` is the point: adding a type to LIVE_EVENT_TYPES without a fixture
    // here is a compile error, so this cannot silently stop covering the whole wire surface.
    const fixtures: Record<(typeof LIVE_EVENT_TYPES)[number], BusEvent> = {
      'session.updated': { type: 'session.updated', session: liveSession({ lastPrompt: SECRET }) },
      'session.removed': { type: 'session.removed', pk: 'claude:x' },
      'inbox.upserted': {
        type: 'inbox.upserted',
        item: inboxItem({ reason: SECRET, ticket: SECRET, payload: { note: SECRET } }),
      },
      'pty.exited': { type: 'pty.exited', ptyId: 'p1', code: 0 },
      'index.progress': { type: 'index.progress', done: 1, total: 2 },
      'usage.updated': { type: 'usage.updated', snapshot: { byModel: [{ note: SECRET }] } },
    };
    // Internal events, interleaved: a leak would show up in the type sequence asserted below.
    ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:x', from: null, to: 'busy' });
    for (const t of LIVE_EVENT_TYPES) {
      ctx.bus.emit(fixtures[t]);
      ctx.bus.emit({ type: 'session.indexed', pk: 'claude:x' });
    }
    ctx.bus.emit({ type: 'hook.received', payload: { message: SECRET } });
    await expect.poll(() => messages.length).toBe(1 + LIVE_EVENT_TYPES.length);
    await new Promise((r) => setTimeout(r, 50));
    expect(messages.map((m) => (m as { type: string }).type)).toEqual(['hello', ...LIVE_EVENT_TYPES]);
    expect(JSON.stringify(messages)).not.toContain('ghp_');
  });

  it('redacts the free text on inbox and usage events, not only on sessions', async () => {
    const { messages } = await connect();
    await expect.poll(() => messages.length).toBe(1);
    ctx.bus.emit({ type: 'inbox.upserted', item: inboxItem({ reason: SECRET, payload: { note: SECRET } }) });
    ctx.bus.emit({ type: 'usage.updated', snapshot: { byModel: [{ note: SECRET }] } });
    await expect.poll(() => messages.length).toBe(3);
    expect(messages[1]).toMatchObject({
      type: 'inbox.upserted',
      item: { reason: '«redacted:github»', payload: { note: '«redacted:github»' } },
    });
    expect(messages[2]).toEqual({
      type: 'usage.updated',
      snapshot: { byModel: [{ note: '«redacted:github»' }] },
    });
  });

  /** A raw TCP upgrade, so the request target bypasses anything a WebSocket client would sanitise. */
  function rawUpgrade(target: string): Promise<void> {
    const port = (server.address() as AddressInfo).port;
    return new Promise((resolve) => {
      const c = netConnect(port, '127.0.0.1', () => {
        c.write(
          `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      rawClients.push(c);
      c.on('error', () => resolve());
      c.on('close', () => resolve());
      c.on('data', () => resolve());
      setTimeout(resolve, 250);
    });
  }

  it('survives an unparseable upgrade target, and refuses a protocol-relative one', async () => {
    // Both of these crashed the daemon before `parseUpgradeTarget`: the URL throw happens
    // synchronously inside the 'upgrade' listener, before the token or Origin check, so one
    // unauthenticated TCP connection took the whole process down. `//evil.example/ws` did not
    // throw — it normalised to pathname '/ws' on a foreign authority and upgraded.
    const good = await connect();
    await expect.poll(() => good.messages.length).toBe(1);
    // The last two carry a VALID token and this server's own Origin, so the only thing standing
    // between them and an upgraded socket is the refusal to normalise a foreign authority.
    for (const t of [
      'http://[',
      '//[/ws',
      '//',
      `//evil.example/ws?token=${TOKEN}`,
      `/\\evil.example/ws?token=${TOKEN}`,
    ]) {
      await rawUpgrade(t);
    }
    // Still alive, still serving, and none of those became a client.
    expect(hub.clientCount()).toBe(1);
    ctx.bus.emit({ type: 'session.removed', pk: 'claude:alive' });
    await expect.poll(() => good.messages.length).toBe(2);
    expect(good.messages[1]).toEqual({ type: 'session.removed', pk: 'claude:alive' });
  });

  it('rejects a bad token, a foreign origin, a missing origin and any other path', async () => {
    await expect(connect('/ws?token=wrong')).rejects.toThrow('status 401');
    await expect(connect('/ws')).rejects.toThrow('status 401');
    await expect(connect(`/ws?token=${TOKEN}`, 'http://evil.test')).rejects.toThrow('status 403');
    await expect(connect(`/ws?token=${TOKEN}`, null)).rejects.toThrow('status 403');
    await expect(connect(`/other?token=${TOKEN}`)).rejects.toThrow();
    expect(hub.clientCount()).toBe(0);
  });

  it('accepts the token in the x-orc-token header as well as the query', async () => {
    const ws = new WebSocket(url, { origin, headers: { 'x-orc-token': TOKEN } });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('unexpected-response', (_r, res) => reject(new Error(`status ${res.statusCode}`)));
      ws.on('error', reject);
    });
    expect(hub.clientCount()).toBe(1);
  });

  it('survives an oversized client frame, losing only that client', async () => {
    const victim = await connect();
    const other = await connect();
    await expect.poll(() => hub.clientCount()).toBe(2);
    const closed = new Promise<void>((r) => victim.ws.once('close', () => r()));
    // Over the server's `maxPayload` (1 MiB); the ws Receiver rejects this at the transport
    // layer, before any 'message' handler could run.
    victim.ws.send('x'.repeat(2 * 1024 * 1024));
    await closed;
    // 1009 "message too big", not a bare 1006: the client is told why it was cut off.
    expect(victim.closes).toEqual([{ code: 1009 }]);
    // Something must be listening for that 'error': an unhandled one is fatal to the daemon.
    expect(warnings.map((a) => a[1])).toContain('live websocket error');
    await expect.poll(() => hub.clientCount()).toBe(1);
    ctx.bus.emit({ type: 'session.removed', pk: 'claude:survivor' });
    await expect.poll(() => other.messages.length).toBe(2);
    expect(other.messages[1]).toEqual({ type: 'session.removed', pk: 'claude:survivor' });
  });

  it('drops a client whose send buffer has run away', async () => {
    await hub.close();
    await new Promise((r) => server.close(r));
    ctx.dispose();
    await boot({ maxBufferedBytes: 1024 });
    const stuck = await connect();
    await expect.poll(() => stuck.messages.length).toBe(1);

    // Stop the CLIENT reading, at the TCP level. Its receive window closes, so the server's
    // socket stops accepting writes and `bufferedAmount` only ever grows. The eviction condition
    // is then CAUSED rather than raced: the previous version emitted twice and hoped ~1 MiB had
    // failed to flush in between, which moves with reporter I/O and CPU load and did fail under
    // the full suite. Reaching into `_socket` is the price of driving the condition directly.
    (stuck.ws as unknown as { _socket: Socket })._socket.pause();

    const big = {
      type: 'session.updated' as const,
      session: liveSession({ lastPrompt: 'a'.repeat(256 * 1024) }),
    };
    // Synchronous, so nothing can drain between iterations. The cap only bounds the failure case.
    let emits = 0;
    while (hub.clientCount() > 0 && emits < 64) {
      ctx.bus.emit(big);
      emits += 1;
    }
    expect(hub.clientCount()).toBe(0);
    expect(emits).toBeLessThan(64);
  });

  it('attaches an error listener to the pre-upgrade socket before anything can throw', () => {
    // The raw socket is an EventEmitter that can emit 'error' (a client resetting mid-handshake)
    // with nothing else listening, and an unhandled 'error' on an EventEmitter is fatal to the
    // process. Driven directly rather than raced, because the listener EXISTING is the property —
    // the window it covers is a few microseconds wide and cannot be hit reliably from outside.
    const socket = new PassThrough();
    hub.handleUpgrade({ url: '/nope', headers: {} } as IncomingMessage, socket, Buffer.alloc(0));
    expect(() => socket.emit('error', new Error('reset during handshake'))).not.toThrow();
    expect(warnings.map((a) => a[1])).toContain('live upgrade socket error');
  });

  it('subscribes to exactly the live types and unsubscribes on close', async () => {
    // Checked on the bus rather than through the socket on purpose: `close()` also terminates
    // every client, and `broadcast` short-circuits when there are none — so "no message arrived"
    // would pass whether or not the handlers were ever removed. A hub that stays subscribed after
    // close leaks itself, and its `WebSocketServer`, for the life of the process.
    let subscribed = 0;
    const types: string[] = [];
    const bus: EventBus = {
      emit: (e) => ctx.bus.emit(e),
      on: (t, fn) => {
        subscribed += 1;
        types.push(t);
        const off = ctx.bus.on(t, fn);
        return () => {
          subscribed -= 1;
          off();
        };
      },
    };
    const probe = createLiveWsHub({ ...ctx, bus }, { token: TOKEN, origins: () => [origin] });
    expect(types).toEqual([...LIVE_EVENT_TYPES]);
    expect(subscribed).toBe(LIVE_EVENT_TYPES.length);
    await probe.close();
    expect(subscribed).toBe(0);
  });

  it('terminates its clients on close and forwards nothing afterwards', async () => {
    const { messages } = await connect();
    await expect.poll(() => messages.length).toBe(1);
    await hub.close();
    ctx.bus.emit({ type: 'session.removed', pk: 'claude:x' });
    await new Promise((r) => setTimeout(r, 50));
    expect(messages).toHaveLength(1);
    expect(hub.clientCount()).toBe(0);
  });
});
