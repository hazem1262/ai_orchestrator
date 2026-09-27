import { z } from 'zod';

export const DiffStatSchema = z.object({
  files: z.number().int(),
  insertions: z.number().int(),
  deletions: z.number().int(),
  untracked: z.number().int(),
});
export type DiffStatView = z.infer<typeof DiffStatSchema>;
