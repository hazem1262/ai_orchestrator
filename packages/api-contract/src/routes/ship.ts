import { z } from 'zod';
import { PrRefSchema } from '../domain.ts';
import { Confirm, IsoString } from './common.ts';

/**
 * A PR reference sent by the client to a write route. Stricter than `PrRefSchema`, which also
 * describes references scraped out of transcripts: the repo must be `owner/name`.
 */
export const ShipPrRefSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  number: z.number().int().positive(),
  url: z.string(),
});

export const PrStatusSchema = z.object({
  pr: PrRefSchema,
  state: z.enum(['open', 'closed', 'merged']),
  title: z.string(),
  checks: z.enum(['pending', 'success', 'failure', 'none']),
  review: z.enum(['approved', 'changes_requested', 'review_required', 'none']),
  updatedAt: IsoString,
  headRef: z.string().nullable(),
  failedChecks: z.array(z.string()),
});

export const ShipSuggestion = z.object({
  message: z.string(),
  title: z.string(),
  body: z.string(),
  base: z.string(),
  branch: z.string(),
  ticket: z.string().nullable(),
});

export const ShipCommitBody = z.object({
  cwd: z.string().min(1),
  message: z.string().min(1).max(5000),
  confirm: Confirm,
});
export const ShipPushBody = z.object({ cwd: z.string().min(1), confirm: Confirm });
export const ShipPrBody = z.object({
  cwd: z.string().min(1),
  title: z.string().min(1).max(250),
  body: z.string().max(60000),
  base: z.string().min(1),
  draft: z.boolean().default(false),
  confirm: Confirm,
});
export const ShipMergeBody = z.object({
  pr: ShipPrRefSchema,
  method: z.enum(['merge', 'squash', 'rebase']),
  confirm: Confirm,
});
export const ShipBackmergeBody = z.object({
  cwd: z.string().min(1),
  projectId: z.string().min(1),
  ticket: z.string().nullable().default(null),
  confirm: Confirm,
});
