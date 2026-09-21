import { z } from 'zod';

/**
 * contracts §11 — exact shape, owned by P2. `worktree` and `compare` are modelled here now
 * (schema-valid) even though the P2 route (Task 13) must reject their presence with
 * `501 not_implemented` until P4 (`worktree`) and P7 (`compare`) implement them. `planApproval`
 * is likewise accepted but has no effect until P4 wires it through.
 */
export const LaunchRequest = z.strictObject({
  source: z.enum(['claude', 'codex']),
  projectId: z.string().nullable(),
  cwd: z.string(),
  prompt: z.string().default(''),
  templateId: z.string().optional(),
  vars: z.record(z.string(), z.string()).default({}),
  ticket: z.string().optional(),
  model: z.string().optional(),
  planApproval: z.boolean().default(false),
  worktree: z
    .object({
      repo: z.string(),
      base: z.string(),
      type: z.enum(['feat', 'fix', 'chore', 'docs', 'refactor']),
      slug: z.string(),
    })
    .optional(),
  compare: z
    .array(z.object({ source: z.enum(['claude', 'codex']), model: z.string().optional() }))
    .optional(),
});
export type LaunchRequest = z.output<typeof LaunchRequest>;
export type LaunchRequestInput = z.input<typeof LaunchRequest>;

export const LaunchResponse = z.object({ ptyId: z.string(), sessionId: z.string().nullable() });
export type LaunchResponse = z.output<typeof LaunchResponse>;

/** Shared confirm body for destructive P2 actions (contracts §6 "Confirmation"). */
export const ConfirmBody = z.strictObject({ confirm: z.boolean().optional() });
export type ConfirmBody = z.output<typeof ConfirmBody>;

export const KillResponse = z.object({ killed: z.enum(['pty', 'pid']) });
export type KillResponse = z.output<typeof KillResponse>;

export const OpenInApp = z.enum(['vscode', 'terminal', 'finder']);
export type OpenInApp = z.output<typeof OpenInApp>;

export const OpenInBody = z.strictObject({ app: OpenInApp, remember: z.boolean().default(true) });
export type OpenInBody = z.output<typeof OpenInBody>;
