import { z } from 'zod';
import { ServiceError } from '../services/errors.ts';

/** Body fragment for destructive endpoints (contracts §6 "Confirmation"). */
export const ConfirmBody = z.object({ confirm: z.boolean().optional() });

export function requireConfirmed(
  body: { confirm?: boolean },
  summary: string,
  details: Record<string, unknown> = {},
): void {
  if (body.confirm !== true) {
    throw new ServiceError('confirmation_required', 409, 'confirmation required', { summary, ...details });
  }
}

/** Optional context services: routes fail with 409 not_enabled when the feature is not wired. */
export function need<T>(svc: T | undefined, name: string): T {
  if (svc === undefined) throw new ServiceError('not_enabled', 409, `${name} is not enabled`);
  return svc;
}

/** Shared by Phase 7 route tests (createApp checks Host = 127.0.0.1:4317). */
export const API_BASE = 'http://127.0.0.1:4317';
export const TEST_TOKEN = 'b'.repeat(64);
