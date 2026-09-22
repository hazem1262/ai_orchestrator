import { z } from 'zod';

/**
 * POST /api/hooks ingest body (P2 minimal ingest; P5 replaces the body by modifying this file,
 * contracts §13). Deliberately `z.looseObject`, not `.strict()`: this body comes from Claude
 * Code's/Codex's own hook payloads, an external, evolving shape we don't control — rejecting
 * unrecognized keys with 422 would break ingestion the moment the CLI adds a field. `message`
 * (and any passthrough field) may carry raw transcript-derived text (e.g. a Notification hook's
 * message) — see task-2-report.md for the redaction note.
 *
 * `message` is the one field we keep and re-serve, so it is the one field that needs a ceiling.
 * It becomes `LiveState.waitingFor`, which is `redact()`ed on EVERY tracker refresh and pushed to
 * every WS client each time — an unbounded message turns one hook into a permanent per-refresh
 * cost and a permanent per-client payload. 4 KiB is far above any real notification (Claude
 * Code's are a sentence) and far below the point where that matters. An over-long body is
 * refused by the route's own `bodyLimit` before this is even parsed.
 */
export const HookIngestBody = z.looseObject({
  session_id: z.string().min(1),
  hook_event_name: z.string().min(1),
  message: z.string().max(4096).optional(),
});
export type HookIngestBody = z.output<typeof HookIngestBody>;
