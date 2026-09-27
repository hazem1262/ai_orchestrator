import { timingSafeEqual } from 'node:crypto';
import type { Handler, MiddlewareHandler } from 'hono';
import { redactedApiError } from './redact-out.ts';
import type { OrcEnv } from './types.ts';

export function allowedHosts(port: number, env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (env.ORC_DEV === '1') hosts.push('127.0.0.1:5173', 'localhost:5173');
  return hosts;
}

export function allowedOrigins(port: number, env: NodeJS.ProcessEnv = process.env): string[] {
  return allowedHosts(port, env).map((h) => `http://${h}`);
}

export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Browser redirects from OAuth providers carry no token; they are protected by a one-time `state`
 * instead. Exempt for `GET` only, and only on these exact paths.
 */
export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([
  '/api/connectors/linear/callback',
  '/api/connectors/slack/callback',
]);

export interface AccessOptions {
  token: string;
  port: () => number;
  env?: NodeJS.ProcessEnv;
}

/**
 * The `/api/*` host, Origin and install-token checks, for local requests only. A request that
 * `remoteGuard` classified as remote was already authenticated there with its device token; the
 * install token never works for it.
 */
export function apiAccessMiddleware(o: AccessOptions): MiddlewareHandler<OrcEnv> {
  return async (c, next) => {
    if ((c.get('remote') ?? null) !== null) {
      await next();
      return;
    }
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (!allowedHosts(o.port(), o.env).includes(host)) {
      return c.json(redactedApiError('forbidden', 'host not allowed'), 403);
    }
    const origin = c.req.header('origin');
    if (origin && !allowedOrigins(o.port(), o.env).includes(origin)) {
      return c.json(redactedApiError('forbidden', 'origin not allowed'), 403);
    }
    const isPublic = c.req.method === 'GET' && PUBLIC_API_PATHS.has(c.req.path);
    if (!isPublic && !tokenMatches(o.token, c.req.header('x-orc-token'))) {
      return c.json(redactedApiError('unauthorized', 'missing or invalid token'), 401);
    }
    await next();
  };
}

/** Serves the install token to a same-origin loopback page, and `null` to every remote request. */
export function bootstrapHandler(o: AccessOptions): Handler<OrcEnv> {
  return (c) => {
    const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' };
    if ((c.get('remote') ?? null) !== null) return c.body('window.__ORC_TOKEN__ = null;\n', 200, headers);
    const remoteAddr = c.env?.incoming?.socket?.remoteAddress;
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    const site = c.req.header('sec-fetch-site');
    const siteOk = site === undefined || site === 'same-origin' || site === 'none';
    if (!isLoopback(remoteAddr) || !allowedHosts(o.port(), o.env).includes(host) || !siteOk) {
      return c.text('forbidden', 403);
    }
    return c.body(`window.__ORC_TOKEN__ = ${JSON.stringify(o.token)};\n`, 200, headers);
  };
}
