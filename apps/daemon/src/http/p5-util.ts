import type { Context } from 'hono';
import type { z } from 'zod';
import { ServiceError } from '../services/errors.ts';
import { redactedApiError } from './redact-out.ts';

type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response };

export async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<Parsed<z.output<S>>> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim().length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, res: c.json(redactedApiError('validation_failed', 'body is not valid JSON'), 400) };
    }
  }
  const r = schema.safeParse(raw);
  if (!r.success)
    return {
      ok: false,
      res: c.json(redactedApiError('validation_failed', 'invalid body', r.error.issues), 400),
    };
  return { ok: true, data: r.data };
}

export function readQuery<S extends z.ZodType>(c: Context, schema: S): Parsed<z.output<S>> {
  const r = schema.safeParse(c.req.query());
  if (!r.success)
    return {
      ok: false,
      res: c.json(redactedApiError('validation_failed', 'invalid query', r.error.issues), 400),
    };
  return { ok: true, data: r.data };
}

export function confirmationRequired(c: Context, summary: unknown): Response {
  return c.json(
    redactedApiError('confirmation_required', 'This action needs {"confirm": true}', { summary }),
    409,
  );
}

export function notFound(c: Context, what: string): Response {
  return c.json(redactedApiError('not_found', `${what} not found`), 404);
}

/** Maps a thrown ServiceError to the redacted contract error body; anything else is rethrown to createApp's onError. */
export function sendError(c: Context, err: unknown): Response {
  if (err instanceof ServiceError) {
    return c.json(redactedApiError(err.code, err.message, err.details), err.status);
  }
  throw err;
}

/** Parses "a,b" into a filtered list of allowed values; undefined when absent. */
export function parseStates<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): T[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));
}
