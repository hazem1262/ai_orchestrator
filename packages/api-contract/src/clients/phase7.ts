import type { z } from 'zod';
import { type AutomationsApi, automationsClient } from './automations.ts';

/** Same shape as the inner `call` of createApiClient (P1): validates the response with `schema`, throws ApiRequestError. */
export type ApiCall = <T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown) => Promise<T>;

/** Grows in Tasks 11 (CompareApi), 14 (SupervisorApi) and 20 (AgncApi). */
export type Phase7Api = AutomationsApi;

export function phase7Client(call: ApiCall): Phase7Api {
  return { ...automationsClient(call) };
}
