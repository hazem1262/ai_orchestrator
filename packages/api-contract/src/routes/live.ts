import { z } from 'zod';
import { SessionSchema } from '../domain.ts';

/** GET /api/live → Session[] (every session that currently has a non-null `live`). */
export const LiveListResponse = z.array(SessionSchema);
export type LiveListResponse = z.output<typeof LiveListResponse>;
