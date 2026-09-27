import { timingSafeEqual } from 'node:crypto';

export type HeaderGetter = (name: string) => string | undefined;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return true;
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

export function hostnameOf(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader.trim()}`).hostname;
  } catch {
    return null;
  }
}

/**
 * `tailscale serve` proxies from 127.0.0.1, so forwarding/identity headers and the Host decide.
 * Errs toward "remote": a local process that forges these headers only gets the stricter checks.
 */
export function isRemoteRequest(get: HeaderGetter, remoteAddress: string | null): boolean {
  if (!isLoopbackAddress(remoteAddress)) return true;
  if (get('tailscale-user-login') !== undefined || get('tailscale-user-name') !== undefined) return true;
  if (
    get('x-forwarded-for') !== undefined ||
    get('x-forwarded-host') !== undefined ||
    get('x-forwarded-proto') !== undefined ||
    get('forwarded') !== undefined
  ) {
    return true;
  }
  const host = hostnameOf(get('host'));
  return host !== null && !LOOPBACK_HOSTS.has(host);
}

/** Case-insensitive; a blank or missing value on either side never matches. */
export function loginMatches(given: string | null | undefined, allowed: string | null | undefined): boolean {
  const a = (given ?? '').trim().toLowerCase();
  const b = (allowed ?? '').trim().toLowerCase();
  return a !== '' && b !== '' && safeEqual(a, b);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
