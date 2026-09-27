import { z } from 'zod';
import { ConfirmBody } from './launch.ts';
import { IsoDate } from './recaps.ts';

export { ConfirmBody };

export const ConnectorId = z.enum(['linear', 'slack']);
export type ConnectorId = z.infer<typeof ConnectorId>;

export const ConnectorStatus = z.object({
  id: ConnectorId,
  connected: z.boolean(),
  status: z.enum(['ok', 'unauthenticated', 'error']),
  authKind: z.enum(['api_key', 'oauth', 'user_token']).nullable(),
  accountLabel: z.string().nullable(),
  connectedAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  oauthConfigured: z.boolean(),
});
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

export const TokenBody = z.object({ token: z.string().trim().min(12).max(500) });
export const OAuthAppBody = z.object({
  clientId: z.string().trim().min(5).max(200),
  clientSecret: z.string().trim().min(10).max(500),
});

export const LinearIssue = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  state: z.string(),
  assignee: z.string().nullable(),
  url: z.string(),
  labels: z.array(z.string()),
});
export type LinearIssue = z.infer<typeof LinearIssue>;

export const ShareSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recap'), sessionPk: z.string().min(3) }),
  z.object({ kind: z.literal('handoff'), sessionPk: z.string().min(3) }),
  z.object({ kind: z.literal('plan'), planPath: z.string().min(1) }),
  z.object({ kind: z.literal('daily'), projectId: z.string().min(1), date: IsoDate }),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(20000) }),
]);
export type ShareSource = z.infer<typeof ShareSource>;

export const LINEAR_IDENTIFIER_RE = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;

export const LinearCommentBody = z.object({ source: ShareSource, confirm: z.boolean().optional() });
export const LinearFollowUpBody = z.object({
  sessionPk: z.string().min(3),
  teamKey: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{0,9}$/)
    .optional(),
  title: z.string().trim().min(3).max(250),
  description: z.string().max(20000).default(''),
  includeRecap: z.boolean().default(true),
  confirm: z.boolean().optional(),
});
export const SlackPostBody = z.object({
  channel: z
    .string()
    .regex(/^[CGD][A-Z0-9]{6,}$/)
    .optional(),
  source: ShareSource,
  confirm: z.boolean().optional(),
});
