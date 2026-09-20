import { z } from 'zod';

export const HealthResponseSchema = z.object({ ok: z.boolean(), version: z.string(), uptimeS: z.number() });
export type HealthResponse = z.output<typeof HealthResponseSchema>;
