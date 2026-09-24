import { z } from 'zod';

const PrRefP3 = z.object({ repo: z.string(), number: z.number(), url: z.string() });

export const PlanSourceSchema = z.enum(['claude-plans', 'wakecap-plans', 'repo-docs']);

export const PlanRefSchema = z.object({
  path: z.string(),
  title: z.string(),
  source: PlanSourceSchema,
  mtime: z.string(),
  reason: z.enum(['ticket', 'time', 'query']),
  tickets: z.array(z.string()),
});
export type PlanRef = z.infer<typeof PlanRefSchema>;

export const SessionLinksSchema = z.object({
  prs: z.array(PrRefP3),
  tickets: z.array(z.object({ id: z.string(), url: z.string().nullable() })),
  plans: z.array(PlanRefSchema),
  artifacts: z.array(
    z.object({ title: z.string().nullable(), url: z.string().nullable(), path: z.string().nullable() }),
  ),
  bridgeSessionId: z.string().nullable(),
});
export type SessionLinks = z.infer<typeof SessionLinksSchema>;

export const PlansQuery = z.object({
  q: z.string().default(''),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const PlanContentQuery = z.object({ path: z.string().min(1) });

export const PlanContentSchema = z.object({ path: z.string(), text: z.string() });
export type PlanContent = z.infer<typeof PlanContentSchema>;
