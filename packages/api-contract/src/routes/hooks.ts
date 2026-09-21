import { z } from 'zod';

/**
 * POST /api/hooks ingest body (P2 minimal ingest; P5 replaces the body by modifying this file,
 * contracts §13). Deliberately `z.looseObject`, not `.strict()`: this body comes from Claude
 * Code's/Codex's own hook payloads, an external, evolving shape we don't control — rejecting
 * unrecognized keys with 422 would break ingestion the moment the CLI adds a field. `message`
 * (and any passthrough field) may carry raw transcript-derived text (e.g. a Notification hook's
 * message) — see task-2-report.md for the redaction note.
 */
export const HookIngestBody = z.looseObject({
  session_id: z.string().min(1),
  hook_event_name: z.string().min(1),
  message: z.string().optional(),
});
export type HookIngestBody = z.output<typeof HookIngestBody>;
