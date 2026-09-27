import { z } from 'zod';

export const AgncSession = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  branch: z.string().nullable(),
  prUrl: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type AgncSession = z.infer<typeof AgncSession>;

export const AgncMessage = z.object({
  id: z.string(),
  role: z.string(),
  status: z.string().nullable(),
  text: z.string(),
  createdAt: z.string().nullable(),
});
export type AgncMessage = z.infer<typeof AgncMessage>;

export const AgncEvent = z.object({
  id: z.string(),
  type: z.string(),
  messageId: z.string().nullable(),
  text: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type AgncEvent = z.infer<typeof AgncEvent>;

export const AgncEventPage = z.object({ items: z.array(AgncEvent), nextCursor: z.string().nullable() });
export type AgncEventPage = z.infer<typeof AgncEventPage>;

export const AgncStatus = z.object({
  enabled: z.boolean(),
  status: z.enum(['ok', 'unauthenticated', 'error', 'disabled']),
  url: z.string(),
  sessions: z.number().int(),
});
export type AgncStatus = z.infer<typeof AgncStatus>;

export const AgncPromptBody = z.object({
  prompt: z.string().min(1).max(20000),
  model: z.string().min(1).optional(),
  confirm: z.boolean().optional(),
});
export type AgncPromptBody = z.infer<typeof AgncPromptBody>;

export const AgncHandoffBody = z.object({
  source: z.enum(['claude', 'codex']),
  id: z.string().min(1),
  repoOwner: z.string().min(1).optional(),
  repoName: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  confirm: z.boolean().optional(),
});
export type AgncHandoffBody = z.infer<typeof AgncHandoffBody>;
