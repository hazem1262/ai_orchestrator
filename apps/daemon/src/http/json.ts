import type { Context } from 'hono';
import type { z } from 'zod';
import { ServiceError } from '../services/errors.ts';

export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ServiceError('validation_failed', 400, 'invalid request', r.error.issues);
  return r.data;
}

export interface ReadJsonOptions {
  /**
   * Controller ruling (Task 5 review): `ResumeRequestSchema`, `PinRequestSchema`,
   * `LabelRequestSchema` and `SaveViewRequestSchema` are `z.strictObject`, so a typo'd key
   * (e.g. `{ mode: 'embedded', frok: true }`) must not be silently dropped. Those four routes
   * pass `unknownKeyStatus: 422` so an unrecognised key is reported as semantically rejected
   * rather than a generic 400; every other body validation failure (and every other route,
   * e.g. `ProjectPatchSchema`) keeps the plain 400.
   */
  unknownKeyStatus?: 400 | 422;
}

export async function readJson<T>(c: Context, schema: z.ZodType<T>, opts: ReadJsonOptions = {}): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ServiceError('validation_failed', 400, 'request body must be JSON');
  }
  const r = schema.safeParse(body);
  if (!r.success) {
    const status =
      opts.unknownKeyStatus === 422 && r.error.issues.some((i) => i.code === 'unrecognized_keys') ? 422 : 400;
    throw new ServiceError('validation_failed', status, 'invalid request', r.error.issues);
  }
  return r.data;
}
