/**
 * The loopback base every request target is resolved against. Any target that resolves somewhere
 * else has smuggled an authority past us and is rejected rather than normalized.
 */
const BASE = 'http://127.0.0.1';

export interface UpgradeTarget {
  /** `URL.pathname` — still percent-encoded, exactly as the old inline `new URL(...)` produced. */
  path: string;
  query: URLSearchParams;
}

/**
 * Parses an HTTP upgrade request target, or returns `null` meaning "reject this connection".
 *
 * **It must never throw.** `http.Server`'s `'upgrade'` listener runs synchronously, so a throw
 * inside it is an uncaught exception and Node kills the process — every PTY, the live tracker and
 * the board with it. Node's HTTP parser accepts request targets that the WHATWG `URL` constructor
 * rejects, and the naked `new URL(req.url ?? '/', base)` this replaces sat *before* the token and
 * Origin checks, so one unauthenticated TCP connection to the loopback port was enough:
 *
 * ```
 * GET http://[ HTTP/1.1   + Upgrade: websocket  -> uncaughtException "Invalid URL"
 * GET //[/ws   HTTP/1.1   + Upgrade: websocket  -> uncaughtException "Invalid URL"
 * ```
 *
 * Three independent nets, because each one alone leaks a case the others catch:
 *
 * 1. **Origin-form only.** A target must begin with `/`. Absolute-form (`GET http://evil.test/ws`,
 *    legal to a proxy and accepted by Node) would otherwise parse to pathname `/ws` while pointing
 *    at another authority.
 * 2. **`try`/`catch`.** The two targets above, and `//`, throw outright.
 * 3. **The resolved origin must still be `BASE`.** This is not redundant with (1): measured,
 *    `//evil.example/ws` *and* `/\evil/ws` — a single backslash, which WHATWG normalizes to a
 *    slash for special schemes — both start with `/` and both resolve to pathname `/ws` on a
 *    foreign origin. A protocol-relative target must be rejected, never normalized.
 *
 * Shared by `ws.ts` (`/pty/:ptyId`) and `live-ws.ts` (`/ws`), and intended for task 16's upgrade
 * dispatcher, so the fix cannot be re-introduced by a third copy of the same line.
 */
export function parseUpgradeTarget(rawUrl: string | undefined | null): UpgradeTarget | null {
  if (!rawUrl?.startsWith('/')) return null;
  let url: URL;
  try {
    url = new URL(rawUrl, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  return { path: url.pathname, query: url.searchParams };
}
