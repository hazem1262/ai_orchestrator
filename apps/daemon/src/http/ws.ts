import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { PtyClientMessageSchema } from '@orc/api-contract';
import { type WebSocket, WebSocketServer } from 'ws';
import type { DaemonContext } from '../context.ts';
import { tokenMatches } from './auth.ts';
import { parseUpgradeTarget } from './upgrade-target.ts';

export interface PtySocketOptions {
  ctx: DaemonContext;
  token: string;
  origins: () => string[];
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachPtyWebSocket(server: Server, o: PtySocketOptions): { close(): Promise<void> } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  // A server-level emit (e.g. a malformed upgrade the ws lib itself chokes on) must not be an
  // unhandled 'error' event — Node treats that as fatal and kills the whole daemon process.
  wss.on('error', (err) => o.ctx.log.warn({ err }, 'pty websocket server error'));

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // The raw pre-upgrade socket is also an EventEmitter that can emit 'error' (e.g. the client
    // resets the connection before the handshake finishes) with no listener otherwise attached.
    socket.on('error', (err) => o.ctx.log.warn({ err }, 'pty upgrade socket error'));
    // Never `new URL(...)` inline here: a target Node's parser accepts and WHATWG rejects would
    // throw synchronously inside this listener and kill the daemon, before any auth ran.
    const target = parseUpgradeTarget(req.url);
    if (!target) {
      socket.destroy();
      return;
    }
    const match = /^\/pty\/([^/]+)$/.exec(target.path);
    if (!match?.[1]) {
      socket.destroy();
      return;
    }
    const ptyId = decodeURIComponent(match[1]);
    const headerToken = req.headers['x-orc-token'];
    const token = (typeof headerToken === 'string' ? headerToken : null) ?? target.query.get('token');
    if (!tokenMatches(o.token, token)) {
      reject(socket, 401, 'Unauthorized');
      return;
    }
    const origin = req.headers.origin;
    if (!origin || !o.origins().includes(origin)) {
      reject(socket, 403, 'Forbidden');
      return;
    }
    if (!o.ctx.pty.get(ptyId)) {
      reject(socket, 404, 'Not Found');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, ptyId));
  };

  function bridge(ws: WebSocket, ptyId: string): void {
    const { pty, bus } = o.ctx;
    let attached: { detach(): void } | null = null;
    // Must be registered before any frames can flow: a transport-level error (e.g. a client
    // frame over maxPayload, which the Receiver rejects before any 'message' handler runs) is an
    // unhandled 'error' event on this socket's EventEmitter and is fatal to the whole process
    // unless something is listening. One bad client must only lose its own connection.
    ws.on('error', (err) => {
      o.ctx.log.warn({ err, ptyId }, 'pty websocket error');
      ws.terminate();
    });
    const offExit = bus.on('pty.exited', (e) => {
      if (e.ptyId !== ptyId) return;
      ws.send(JSON.stringify({ t: 'exit', code: e.code }));
      ws.close(1000, 'process exited');
    });
    try {
      const a = pty.attach(ptyId, (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(Buffer.from(chunk, 'utf8'), { binary: true });
      });
      attached = a;
      ws.send(Buffer.from(a.scrollback, 'utf8'), { binary: true });
      const info = pty.get(ptyId);
      if (info?.exitedAt) {
        ws.send(JSON.stringify({ t: 'exit', code: info.exitCode }));
        ws.close(1000, 'process exited');
      }
    } catch {
      ws.close(1011, 'pty unavailable');
    }
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      const msg = PtyClientMessageSchema.safeParse(parsed);
      if (!msg.success) return;
      try {
        if (msg.data.t === 'in') pty.write(ptyId, msg.data.d);
        else pty.resize(ptyId, msg.data.cols, msg.data.rows);
      } catch {
        // the PTY exited between frames; the exit frame follows
      }
    });
    ws.on('close', () => {
      offExit();
      attached?.detach();
    });
  }

  server.on('upgrade', onUpgrade);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.off('upgrade', onUpgrade);
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}
