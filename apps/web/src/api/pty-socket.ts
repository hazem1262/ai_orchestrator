import type { PtyClientMessage } from '@orc/api-contract';

export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;
export type PtySocketStatus = 'connecting' | 'open' | 'closed';

export interface PtySocketHandlers {
  onData(data: Uint8Array): void;
  onExit(code: number | null): void;
  onStatus?(s: PtySocketStatus): void;
  onReset?(): void;
}

export interface PtySocket {
  send(msg: PtyClientMessage): void;
  close(): void;
}

const OPEN = 1;

export function ptySocketUrl(ptyId: string, token: string, loc: { protocol: string; host: string }): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/pty/${encodeURIComponent(ptyId)}?token=${encodeURIComponent(token)}`;
}

function toBytes(data: unknown): Uint8Array | null {
  // `instanceof ArrayBuffer`/`DataView` checks fail across realms (e.g. a jsdom window vs. the
  // Node realm that built the test's buffer), so detect by tag/shape instead.
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof data === 'object' && Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
    return new Uint8Array(data as ArrayBuffer);
  }
  return null;
}

export function connectPty(
  ptyId: string,
  h: PtySocketHandlers,
  o: {
    token?: string;
    WebSocketImpl?: WebSocketCtor;
    location?: { protocol: string; host: string };
    maxDelayMs?: number;
  } = {},
): PtySocket {
  const WS = o.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor);
  const loc = o.location ?? window.location;
  let ws: WebSocketLike | null = null;
  let stopped = false;
  let exited = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = (): void => {
    h.onStatus?.('connecting');
    const sock = new WS(ptySocketUrl(ptyId, o.token ?? '', loc));
    sock.binaryType = 'arraybuffer';
    ws = sock;
    let first = true;
    sock.onopen = () => {
      attempt = 0;
      h.onStatus?.('open');
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data) as { t?: string; code?: unknown };
          if (m.t === 'exit') {
            exited = true;
            h.onExit(typeof m.code === 'number' ? m.code : null);
          }
        } catch {
          // ignore malformed control frames
        }
        return;
      }
      const bytes = toBytes(ev.data);
      if (!bytes) return;
      if (first) {
        first = false;
        h.onReset?.();
      }
      h.onData(bytes);
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      h.onStatus?.('closed');
      if (stopped || exited) return;
      const delay = Math.min(250 * 2 ** attempt, o.maxDelayMs ?? 5000);
      attempt += 1;
      timer = setTimeout(open, delay);
    };
  };

  open();
  return {
    send(msg) {
      if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const current = ws;
      ws = null;
      current?.close();
    },
  };
}
