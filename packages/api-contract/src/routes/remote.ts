import { z } from 'zod';
import { ConfirmBody } from './launch.ts';

export const PairBody = z.object({
  code: z.string().regex(/^[A-Z2-9]{8}$/),
  name: z.string().trim().min(1).max(60),
});
export type PairBody = z.infer<typeof PairBody>;
export const PairResult = z.object({ deviceId: z.string(), deviceToken: z.string() });
export type PairResult = z.infer<typeof PairResult>;
export const PairingCode = z.object({ code: z.string(), expiresAt: z.string(), url: z.string().nullable() });
export type PairingCode = z.infer<typeof PairingCode>;

export const RemoteDevice = z.object({
  id: z.string(),
  name: z.string(),
  login: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  credentials: z.number().int(),
});
export type RemoteDevice = z.infer<typeof RemoteDevice>;

export const RemoteConfigBody = z.object({
  enabled: z.boolean(),
  origin: z
    .string()
    .regex(/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/)
    .nullable(),
  allowedLogin: z.string().trim().min(3).max(200).nullable(),
});
export type RemoteConfigBody = z.infer<typeof RemoteConfigBody>;

export const RemoteStatus = z.object({
  enabled: z.boolean(),
  origin: z.string().nullable(),
  allowedLogin: z.string().nullable(),
  isRemote: z.boolean(),
  deviceId: z.string().nullable(),
  stepUpValidUntil: z.string().nullable(),
  funnelDetected: z.boolean(),
  pairingActiveUntil: z.string().nullable(),
});
export type RemoteStatus = z.infer<typeof RemoteStatus>;

export const AwayMode = z.enum(['auto', 'on', 'off']);
export type AwayMode = z.infer<typeof AwayMode>;
export const AwayState = z.object({
  away: z.boolean(),
  mode: AwayMode,
  reason: z.enum(['manual', 'idle', 'present']),
  idleSeconds: z.number().nullable(),
});
export type AwayState = z.infer<typeof AwayState>;
export const AwayBody = z.object({ mode: AwayMode });
export type AwayBody = z.infer<typeof AwayBody>;

export const ReplyBody = z.object({ text: z.string().trim().min(1).max(8000) });
export type ReplyBody = z.infer<typeof ReplyBody>;
export const ApproveBody = ConfirmBody;
export type ApproveBody = z.infer<typeof ApproveBody>;

export const PushSubscriptionBody = z.object({
  endpoint: z.url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(10), auth: z.string().min(8) }),
});
export type PushSubscriptionBody = z.infer<typeof PushSubscriptionBody>;
export const PushUnsubscribeBody = z.object({ endpoint: z.url() });
export type PushUnsubscribeBody = z.infer<typeof PushUnsubscribeBody>;

export const StepUpResult = z.object({ validUntil: z.string() });
export type StepUpResult = z.infer<typeof StepUpResult>;
export const WebAuthnVerifyBody = z.object({ response: z.record(z.string(), z.unknown()) });
export type WebAuthnVerifyBody = z.infer<typeof WebAuthnVerifyBody>;
