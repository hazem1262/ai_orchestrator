import { z } from 'zod';

export const AuditActorSchema = z.enum(['user', 'automation', 'supervisor', 'remote']);

export const AuditEntrySchema = z.object({
  id: z.string(),
  ts: z.string(),
  actor: AuditActorSchema,
  actorDetail: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  result: z.enum(['ok', 'error', 'denied']),
  error: z.string().nullable(),
});

export const AuditQuery = z.object({
  sessionPk: z.string().optional(),
  action: z.string().optional(),
  actor: AuditActorSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  q: z.string().optional(),
  projectId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type AuditQuery = z.infer<typeof AuditQuery>;
