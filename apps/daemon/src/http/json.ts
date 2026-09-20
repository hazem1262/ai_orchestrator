import type { Context } from 'hono';
import type { z } from 'zod';
import { ServiceError } from '../services/errors.ts';

export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ServiceError('validation_failed', 400, 'invalid request', r.error.issues);
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
    throw new ServiceError('validation_failed', status, 'invalid request', r.error.issues);
  }
  return r.data;
}
