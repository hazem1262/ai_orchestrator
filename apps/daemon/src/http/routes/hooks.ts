import { apiError, HookIngestBody } from '@orc/api-contract';
import { bodyLimit } from 'hono/body-limit';
import type { DaemonContext } from '../../context.ts';
import type { OrcApp } from '../types.ts';

/**
 * Generous against any real hook payload — Claude Code sends the submitted prompt and the tool
 * input, both of which we discard — and small enough that the ingest cannot be used to make the
 * daemon buffer. Without it a 32 MiB body is accepted and held in memory before a single field
 * of it is read.
 */
export const HOOK_BODY_LIMIT_BYTES = 256 * 1024;

/**
 * The minimal hook ingest. The daemon never installs this hook itself — the user pastes the
 * snippet into `~/.claude/settings.json` by hand (the consented install is phase 5), so the body
 * that arrives here is Claude Code's own payload and carries far more than we want: the submitted
 * prompt, the tool input, the transcript path.
 *
 * Only `session_id`, `hook_event_name` and `message` are kept. Everything else is dropped on the
 * floor and never logged — including in the `hook.received` bus payload, which carries no message
 * at all, since bus events reach the WS hub and the log.
 *
 * NOT YET REGISTERED IN PRODUCTION — see the note on `registerLiveRoutes`.
 */
export function registerHookRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.post(
    '/api/hooks',
    bodyLimit({
      maxSize: HOOK_BODY_LIMIT_BYTES,
      onError: (c) => c.json(apiError('payload_too_large', 'hook payload too large'), 413),
    }),
    async (c) => {
      const raw: unknown = await c.req.json().catch(() => null);
      const parsed = HookIngestBody.safeParse(raw);
      if (!parsed.success) {
        return c.json(apiError('validation_failed', 'invalid hook payload', parsed.error.issues), 400);
      }
      const b = parsed.data;
      ctx.bus.emit({
        type: 'hook.received',
        payload: { sessionId: b.session_id, event: b.hook_event_name },
      });
      ctx.live?.applyHook({
        sessionId: b.session_id,
        event: b.hook_event_name,
        message: b.message ?? null,
        ts: new Date().toISOString(),
      });
      return c.json({ ok: true });
    },
  );
}
