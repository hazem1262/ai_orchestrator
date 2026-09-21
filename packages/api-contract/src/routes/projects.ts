import { z } from 'zod';

/** PATCH /api/projects/:id. No defaults on purpose: absent keys must stay untouched. */
export const ProjectPatchSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  pathPrefixes: z.array(z.string().startsWith('/')).min(1).optional(),
  hidden: z.boolean().optional(),
  openIn: z.enum(['vscode', 'terminal', 'finder']).optional(),
  ticketRegex: z.string().nullable().optional(),
  prodPatterns: z.array(z.string()).optional(),
  features: z
    .object({ workStreams: z.boolean(), prodBadges: z.boolean(), recaps: z.boolean() })
    .partial()
    .optional(),
});
export type ProjectPatch = z.output<typeof ProjectPatchSchema>;
