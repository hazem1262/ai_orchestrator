import { redactDeep } from '@orc/core';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** The only way transcript-bearing JSON leaves the daemon (contracts §8). */
export function redactedJson(c: Context, body: unknown, status: ContentfulStatusCode = 200): Response {
  // `body` is untyped here, so hono's JSONParsed<T> inference has nothing to narrow on and recurses
  // until tsc gives up (TS2589); the value is plain JSON data, so the cast loses nothing.
  return c.json(redactDeep(body) as Record<string, unknown>, status);
}
