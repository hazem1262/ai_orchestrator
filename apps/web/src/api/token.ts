export const DEVICE_TOKEN_KEY = 'orc.deviceToken';

declare global {
  interface Window {
    __ORC_TOKEN__?: string | null;
  }
}

export function isLoopbackOrigin(hostname: string = window.location.hostname): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

export function readDeviceToken(): string | null {
  try {
    return window.localStorage.getItem(DEVICE_TOKEN_KEY);
  } catch {
    return null; // private mode or blocked storage
  }
}

export function setDeviceToken(token: string): void {
  try {
    window.localStorage.setItem(DEVICE_TOKEN_KEY, token);
  } catch {
    // storage unavailable; the token lives for this page only
  }
}

export function clearDeviceToken(): void {
  try {
    window.localStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    // nothing to clear
  }
}

/** The install token is injected by /bootstrap.js on the Mac; remote devices use their paired device token. */
export function resolveToken(): string {
  if (typeof window === 'undefined') return '';
  const injected = window.__ORC_TOKEN__;
  if (typeof injected === 'string' && injected !== '') return injected;
  return readDeviceToken() ?? '';
}
