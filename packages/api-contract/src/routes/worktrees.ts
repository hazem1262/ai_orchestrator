import { z } from 'zod';
import { Confirm, IsoString } from './common.ts';
import { PrStatusSchema } from './ship.ts';

export const WorktreeType = z.enum(['feat', 'fix', 'chore', 'docs', 'refactor']);

export const WorktreeViewSchema = z.object({
  path: z.string(),
  repo: z.string(),
  branch: z.string(),
  base: z.string().nullable(),
  ticket: z.string().nullable(),
  dirty: z.boolean(),
  prUrl: z.string().nullable(),
  state: z.enum(['active', 'archived']),
  createdByApp: z.boolean(),
  head: z.string().nullable(),
  isMain: z.boolean(),
  origin: z.enum(['app', 'config', 'session-cwd', 'claude-json', 'worktree-dir', 'sibling', 'scratchpad']),
  sessionPks: z.array(z.string()),
  projectId: z.string().nullable(),
  prStatus: PrStatusSchema.nullable(),
  updatedAt: IsoString,
});

export const WorktreeListQuery = z.object({
  projectId: z.string().optional(),
  state: z.enum(['active', 'archived']).optional(),
  repo: z.string().optional(),
});

export const CreateWorktreeBody = z.object({
  repo: z.string().min(1),
  base: z.string().min(1),
  type: WorktreeType,
  ticket: z.string().nullable(),
  slug: z.string().min(1).max(80),
  runSetup: z.boolean().default(true),
  launch: z
    .object({
      source: z.enum(['claude', 'codex']),
      prompt: z.string().default(''),
      templateId: z.string().optional(),
      planApproval: z.boolean().default(false),
    })
    .optional(),
  confirm: Confirm,
});

export const WorktreeScriptBody = z.object({
  path: z.string().min(1),
  which: z.enum(['setup', 'run', 'archive']),
  confirm: Confirm,
});
export const WorktreeOpenBody = z.object({
  path: z.string().min(1),
  target: z.enum(['vscode', 'terminal', 'finder']),
});
export const WorktreePathBody = z.object({ path: z.string().min(1), confirm: Confirm });
export const WorktreeArchiveBody = z.object({
  path: z.string().min(1),
  confirm: Confirm,
  confirmExternal: z.boolean().default(false),
});
export const SyncPreview = z.object({
  path: z.string(),
  mainPath: z.string(),
  files: z.array(z.string()),
  mainDirty: z.array(z.string()),
});
export const CreateWorktreeResult = z.object({
  worktree: WorktreeViewSchema,
  setupPtyId: z.string().nullable(),
  launch: z.object({ ptyId: z.string(), sessionId: z.string().nullable() }).nullable(),
});
