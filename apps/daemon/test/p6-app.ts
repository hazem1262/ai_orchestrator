import { apiError } from '@orc/api-contract';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { redactedApiError } from '../src/http/redact-out.ts';
import type { OrcApp, OrcEnv } from '../src/http/types.ts';
import { ServiceError } from '../src/services/errors.ts';
import { withRemote } from './p6-fakes.ts';

/**
 * A bare `Hono<OrcEnv>` with the test-only remote marker and the same error rendering as
 * `createApp` (`redactedApiError` for `ServiceError`, constant strings otherwise). Route unit
 * tests register one route family on it; the token/host middleware is exercised through
 * `createP3Harness` instead.
 */
export function p6TestApp(): OrcApp {
  const app = withRemote(new Hono<OrcEnv>());
  app.onError((err, c) => {
    if (err instanceof ServiceError)
      return c.json(redactedApiError(err.code, err.message, err.details), err.status);
    if (err instanceof HTTPException) return c.json(redactedApiError('bad_request', err.message), 400);
    return c.json(apiError('internal', 'internal error'), 500);
  });
  return app;
}

export async function send(
  app: OrcApp,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(`http://127.0.0.1:4317${path}`, {
    method,
    headers: { 'content-type': 'application/json', host: '127.0.0.1:4317', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
