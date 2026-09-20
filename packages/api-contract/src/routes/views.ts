import { z } from 'zod';

export const SavedViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  query: z.record(z.string(), z.string()),
  createdAt: z.string(),
});
export type SavedView = z.output<typeof SavedViewSchema>;

export const SaveViewRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  query: z.record(z.string(), z.string()),
});
