import type { Context } from 'hono';
import type { z } from 'zod';
import { ServiceError } from '../services/errors.ts';

/**
 * Turns the first zod issue into a legible suffix, e.g. `invalid request: pathPrefixes.0 Invalid
 * input: must start with "/"` — so a client can point a UI error at the offending field instead of
 * only ever seeing a flat "invalid request". `details` (the full issue list) is untouched for
 * anything that wants the structured form.
 */
function describeError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'invalid request';
  const path = first.path.join('.');
  return path ? `invalid request: ${path} ${first.message}` : `invalid request: ${first.message}`;
}

export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ServiceError('validation_failed', 400, describeError(r.error), r.error.issues);
  return r.data;
}

/**
 * Controller ruling: every `z.strictObject` request-body schema (`ProjectPatchSchema`,
 * `ResumeRequestSchema`, `PinRequestSchema`, `LabelRequestSchema`, `SaveViewRequestSchema`) rejects
 * an unrecognised key (e.g. a typo'd `{ mode: 'embedded', frok: true }`) with 422
 * `validation_failed` — the JSON is well-formed, but semantically rejected, unlike a generic 400
 * for a missing/mistyped field. Every other body validation failure stays 400.
 */
export async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ServiceError('validation_failed', 400, 'request body must be JSON');
  }
  const r = schema.safeParse(body);
  if (!r.success) {
    const status = r.error.issues.some((i) => i.code === 'unrecognized_keys') ? 422 : 400;
    throw new ServiceError('validation_failed', status, describeError(r.error), r.error.issues);
  }
  return r.data;
}
