import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectPty, ptySocketUrl, type WebSocketLike } from './pty-socket.ts';

class FakeWS implements WebSocketLike {
  static instances: FakeWS[] = [];
  readonly url: string;
  binaryType = 'blob';
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.drop();
  }
  accept(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const loc = { protocol: 'http:', host: '127.0.0.1:4317' };

describe('pty socket', () => {
  beforeEach(() => {
    FakeWS.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('builds the URL', () => {
    expect(ptySocketUrl('p 1', 't/k', loc)).toBe('ws://127.0.0.1:4317/pty/p%201?token=t%2Fk');
    expect(ptySocketUrl('p', 't', { protocol: 'https:', host: 'box.ts.net' })).toBe(
      'wss://box.ts.net/pty/p?token=t',
    );
  });

  it('streams bytes, resets before replay, sends only when open and stops after exit', () => {
    const events: string[] = [];
    const sock = connectPty(
      'p1',
      {
        onData: (d) => events.push(`data:${new TextDecoder().decode(d)}`),
        onExit: (code) => events.push(`exit:${code}`),
        onStatus: (s) => events.push(`status:${s}`),
        onReset: () => events.push('reset'),
      },
      { token: 'tok', WebSocketImpl: FakeWS, location: loc },
    );
    const ws = FakeWS.instances[0];
    if (!ws) throw new Error('no socket');
    expect(ws.binaryType).toBe('arraybuffer');
    sock.send({ t: 'in', d: 'early' });
    ws.accept();
    sock.send({ t: 'resize', cols: 80, rows: 24 });
    ws.message(bytes('scrollback'));
    ws.message(bytes('live'));
    ws.message('{"t":"exit","code":0}');
    ws.drop();
    vi.advanceTimersByTime(10_000);
    expect(ws.sent).toEqual(['{"t":"resize","cols":80,"rows":24}']);
    expect(events).toEqual([
      'status:connecting',
      'status:open',
      'reset',
      'data:scrollback',
      'data:live',
      'exit:0',
      'status:closed',
    ]);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('reconnects with backoff and replays after each reconnect', () => {
    const resets: number[] = [];
    connectPty(
      'p1',
      { onData: () => undefined, onExit: () => undefined, onReset: () => resets.push(1) },
      {
        WebSocketImpl: FakeWS,
        location: loc,
      },
    );
    FakeWS.instances[0]?.drop();
    vi.advanceTimersByTime(249);
    expect(FakeWS.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWS.instances).toHaveLength(2);
    FakeWS.instances[1]?.drop();
    vi.advanceTimersByTime(500);
    expect(FakeWS.instances).toHaveLength(3);
    const third = FakeWS.instances[2];
    third?.accept();
    third?.message(bytes('again'));
    expect(resets).toEqual([1]);
    third?.drop();
    vi.advanceTimersByTime(250);
    expect(FakeWS.instances).toHaveLength(4);
  });

  it('stops reconnecting after close()', () => {
    const sock = connectPty(
      'p1',
      { onData: () => undefined, onExit: () => undefined },
      { WebSocketImpl: FakeWS, location: loc },
    );
    sock.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.instances).toHaveLength(1);
  });
});
