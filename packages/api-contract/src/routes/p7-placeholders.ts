import { z } from 'zod';

// Placeholders: each is replaced by the real schema in Tasks 11 / 20, which delete the line here.
export const CompareGroup = z.object({ id: z.string() });
export type CompareGroup = z.infer<typeof CompareGroup>;
export const CompareEstimate = z.object({ variants: z.number() });
export type CompareEstimate = z.infer<typeof CompareEstimate>;
export const CompareView = z.object({ group: CompareGroup });
export type CompareView = z.infer<typeof CompareView>;
export const ArchiveLosersResult = z.object({ results: z.array(z.unknown()) });
export type ArchiveLosersResult = z.infer<typeof ArchiveLosersResult>;
export const AgncSession = z.object({ id: z.string() });
export type AgncSession = z.infer<typeof AgncSession>;
export const AgncMessage = z.object({ id: z.string() });
export type AgncMessage = z.infer<typeof AgncMessage>;
export const AgncEvent = z.object({ id: z.string() });
export type AgncEvent = z.infer<typeof AgncEvent>;
