import { z } from 'zod';
import { TestResultSchema } from '../domain.ts';
import { Confirm, IsoString } from './common.ts';
import { PrStatusSchema } from './ship.ts';
import { WorktreeViewSchema } from './worktrees.ts';

const Hunk = z.object({
  header: z.string(),
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  lines: z.array(z.string()),
});

export const DiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'binary']),
  additions: z.number().int(),
  deletions: z.number().int(),
  patch: z.string(),
  hunks: z.array(Hunk),
});

export const DiffResultSchema = z.object({
  cwd: z.string(),
  from: z.string(),
  to: z.string(),
  files: z.array(DiffFileSchema),
  additions: z.number().int(),
  deletions: z.number().int(),
});

export const DiffQuery = z.object({
  cwd: z.string().min(1),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const DiffRevertBody = z.object({
  cwd: z.string().min(1),
  file: z.string().min(1),
  hunkIndex: z.number().int().nonnegative().optional(),
  from: z.string().optional(),
  confirm: Confirm,
});

export const CheckpointRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  worktreePath: z.string(),
  turn: z.number().int(),
  ref: z.string(),
  commit: z.string(),
  createdAt: IsoString,
  kind: z.enum(['turn', 'safety', 'manual']),
});

export const CheckpointCreateBody = z.object({ sessionPk: z.string().min(1), confirm: Confirm });
export const CheckpointRewindBody = z.object({ confirm: Confirm });

export const ReviewCommentSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  side: z.enum(['old', 'new']),
  body: z.string().trim().min(1).max(4000),
});

export const ReviewCommentsBody = z.object({
  comments: z.array(ReviewCommentSchema).min(1).max(200),
  deliver: z.enum(['session', 'text']),
  confirm: Confirm,
});

export const ReviewSummarySchema = z.object({
  sessionPk: z.string(),
  cwd: z.string(),
  worktree: WorktreeViewSchema.nullable(),
  files: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number() })),
  additions: z.number(),
  deletions: z.number(),
  lastTest: TestResultSchema.nullable(),
  recap: z.string().nullable(),
  pr: PrStatusSchema.nullable(),
  owned: z.boolean(),
  checkpoints: z.array(CheckpointRecordSchema),
});
