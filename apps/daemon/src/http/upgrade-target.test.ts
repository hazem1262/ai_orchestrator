import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseUpgradeTarget } from './upgrade-target.ts';

describe('parseUpgradeTarget', () => {
  it.each([
    ['/ws', '/ws'],
    ['/ws?token=abc', '/ws'],
    ['/ws#frag', '/ws'],
    ['/pty/abc-123', '/pty/abc-123'],
    ['/a/../ws', '/ws'],
    // Percent-encoding is preserved, not decoded: `/%2Fws` must not become `/ws`, or a path
    // check would pass for a path the caller never matched. `ws.ts` decodes only the captured id.
    ['/%2Fws', '/%2Fws'],
    ['/ws%00', '/ws%00'],
  ])('accepts %s', (raw, path) => {
    expect(parseUpgradeTarget(raw)?.path).toBe(path);
  });

  it('reads the query the same way the inline URL did', () => {
    expect(parseUpgradeTarget('/pty/x?token=t1&other=2')?.query.get('token')).toBe('t1');
    expect(parseUpgradeTarget('/ws')?.query.get('token')).toBeNull();
  });

  it.each([
    // Throws out of `new URL` — this is the crash.
    ['http://['],
    ['//[/ws'],
    ['//'],
    // Parses, but resolves to a FOREIGN authority with pathname '/ws'. Rejected, not normalized.
    ['//evil.example/ws'],
    ['/\\evil.example/ws'],
    ['http://evil.example/ws'],
    // Absolute-form: legal to a proxy, accepted by Node's parser, not ours.
    ['http://127.0.0.1/ws'],
    // Not origin-form at all.
    ['*'],
    ['ws'],
    [''],
    [undefined],
    [null],
  ])('rejects %s', (raw) => {
    expect(parseUpgradeTarget(raw as string | undefined | null)).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    const hostile = ['http://[', '//[/ws', '%', '/%', '/%zz', `/${'a'.repeat(100_000)}`, '/\0'];
    for (const raw of hostile) expect(() => parseUpgradeTarget(raw)).not.toThrow();
  });
});

/**
 * The regression this helper exists for, driven end to end: a raw TCP client writing a request
 * target Node's HTTP parser accepts. An 'upgrade' listener runs synchronously, so a throw inside
 * it is an uncaught exception, and `socket.on('error')` cannot catch it.
 */
describe('an upgrade listener built on it', () => {
  let server: Server | undefined;
  const clients: Socket[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    if (server) await new Promise((r) => server?.close(r));
    server = undefined;
  });

  function rawUpgrade(port: number, target: string): Promise<void> {
    return new Promise((resolve) => {
      const c = connect(port, '127.0.0.1', () => {
        c.write(
          `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
            'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      clients.push(c);
      c.on('error', () => resolve());
      c.on('close', () => resolve());
      c.on('data', () => resolve());
      setTimeout(resolve, 250);
    });
  }

  it('survives targets that Node accepts and WHATWG URL rejects', async () => {
    const seen: Array<string | null> = [];
    const thrown: unknown[] = [];
    server = createServer();
    server.on('upgrade', (req, socket) => {
      // Exactly the shape both sockets use.
      try {
        const target = parseUpgradeTarget(req.url);
        seen.push(target?.path ?? null);
      } catch (err) {
        // Only reachable if the helper throws; in production nothing would catch it.
        thrown.push(err);
      }
      socket.destroy();
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    for (const t of ['http://[', '//[/ws', '//evil.example/ws', '/ws']) await rawUpgrade(port, t);

    expect(thrown).toEqual([]);
    // The three hostile targets are rejected; only the honest one yields a path.
    expect(seen).toEqual([null, null, null, '/ws']);
  });
});
