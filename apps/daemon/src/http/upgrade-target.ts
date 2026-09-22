/**
 * The loopback base every request target is resolved against. Any target that resolves somewhere
 * else has smuggled an authority past us and is rejected rather than normalized.
 */
const BASE = 'http://127.0.0.1';

export interface UpgradeTarget {
  /** `URL.pathname` — still percent-encoded, exactly as the old inline `new URL(...)` produced. */
  path: string;
  /**
   * The same path split on `/` and percent-DECODED, one entry per segment (`/pty/a%20b` ->
   * `['pty', 'a b']`). Callers take ids from here; nothing outside this module should ever call
   * `decodeURIComponent` on a request target, because that is the second way this listener died.
   */
  segments: string[];
  query: URLSearchParams;
}

/**
 * Parses an HTTP upgrade request target, or returns `null` meaning "reject this connection".
 *
 * **It must never throw, and neither must anything a caller then has to do to its result.**
 * `http.Server`'s `'upgrade'` listener runs synchronously, so a throw inside it is an uncaught
 * exception and Node kills the process — every PTY, the live tracker and the board with it, plus
 * a leaked temp home per crash in tests. One unauthenticated TCP connection to the loopback port
 * was enough, twice over:
 *
 * ```
 * GET http://[ HTTP/1.1   + Upgrade: websocket  -> uncaughtException "Invalid URL"
 * GET //[/ws   HTTP/1.1   + Upgrade: websocket  -> uncaughtException "Invalid URL"
 * GET /pty/%   HTTP/1.1   + Upgrade: websocket  -> uncaughtException "URI malformed"
 * ```
 *
 * The third one is why `segments` exists. Round 1 fixed the parse and left the caller decoding
 * `match[1]` itself, one line below the fix and still before the token check — and this module's
 * own test asserting that `parseUpgradeTarget('/%')` does not throw was true and useless, because
 * the caller threw instead. Returning already-decoded segments removes the caller's ability to
 * make that mistake; `path` stays encoded so existing path matching is byte-for-byte unchanged.
 *
 * Four independent nets, because each one alone leaks a case the others catch:
 *
 * 1. **Origin-form only.** A target must begin with `/`. Removing it alone fails exactly three
 *    cases: `http://127.0.0.1/ws` (absolute-form, legal to a proxy and accepted by Node — and
 *    note it resolves to OUR origin, so no other net sees it) and the two non-paths `*` and a
 *    bare `ws`. Absolute-form pointing elsewhere, `http://evil.example/ws`, is caught here too
 *    but is net 3's case, not this one's.
 * 2. **`try`/`catch` around `new URL`.** `http://[`, `//[/ws` and `//` throw outright. Removing
 *    it alone fails six, including both end-to-end tests, with an unhandled exception.
 * 3. **The resolved origin must still be `BASE`.** Not redundant with (1): measured,
 *    `//evil.example/ws` *and* `/\evil.example/ws` — a single backslash, which WHATWG normalizes
 *    to a slash for special schemes — both start with `/` and both resolve to pathname `/ws` on a
 *    foreign origin. A protocol-relative target must be rejected, never normalized. Removing this
 *    net alone fails five, and against the live daemon it yields a real `101` to a foreign
 *    authority.
 * 4. **Every segment must percent-decode.** `/pty/%`, `/pty/%zz`, `/pty/%C0%80`, `/pty/%ed%a0%80`
 *    and `/pty/%E0%A4%A` are all accepted by Node's parser and all throw `URIError` in
 *    `decodeURIComponent`. Fail closed: a target we cannot read is refused, not guessed at.
 *    Removing this net alone fails thirteen, including both end-to-end tests.
 *
 * Shared by `ws.ts` (`/pty/:ptyId`) and `live-ws.ts` (`/ws`), and intended for task 16's upgrade
 * dispatcher, so the fix cannot be re-introduced by a fourth copy of the same line.
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
  const segments: string[] = [];
  // `[^/]+` in a caller's path regex captures exactly one segment, so decoding per segment here is
  // the same decode the caller used to do — it simply cannot escape into the listener any more.
  for (const raw of url.pathname.split('/').slice(1)) {
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return { path: url.pathname, segments, query: url.searchParams };
}
