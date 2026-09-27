import type { z } from 'zod';

/** Same shape as the inner `call` of createApiClient (P1): validates the response with `schema`, throws ApiRequestError. */
export type ApiCall = <T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown) => Promise<T>;

/** Grows in Tasks 2 (AutomationsApi), 11 (CompareApi), 14 (SupervisorApi) and 20 (AgncApi). */
export type Phase7Api = Record<never, never>;

export function phase7Client(_call: ApiCall): Phase7Api {
  return {};
}
