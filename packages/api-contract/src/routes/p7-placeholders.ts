import { z } from 'zod';

// Placeholders: each is replaced by the real schema in Tasks 11 / 20, which delete the line here.
export const AgncSession = z.object({ id: z.string() });
export type AgncSession = z.infer<typeof AgncSession>;
export const AgncMessage = z.object({ id: z.string() });
export type AgncMessage = z.infer<typeof AgncMessage>;
export const AgncEvent = z.object({ id: z.string() });
export type AgncEvent = z.infer<typeof AgncEvent>;
