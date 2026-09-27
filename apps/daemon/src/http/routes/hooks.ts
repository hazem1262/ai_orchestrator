import { HookIngestBody } from '@orc/api-contract';
import { HOOK_BODY_LIMIT_BYTES, mapHookPayload, pickHookFields } from '@orc/core';
import { bodyLimit } from 'hono/body-limit';
import type { DaemonContext } from '../../context.ts';
import { redactedApiError } from '../redact-out.ts';
import type { OrcApp } from '../types.ts';

/** Re-exported for the Phase 2 route tests; the value lives in `@orc/core` `derive/hooks.ts`. */
export { HOOK_BODY_LIMIT_BYTES };

/**
 * The hook ingest behind the real-time bridge. The body that arrives here is Claude Code's own
 * payload and carries far more than we want: the submitted prompt, the tool input, the
 * transcript path.
 *
 * Only `session_id`, `hook_event_name`, `message` and `tool_name` are kept (`pickHookFields`).
 * Everything else is dropped on the floor and never logged — including in the `hook.received`
 * bus payload, which carries no message at all, since bus events reach the WS hub and the log.
 *
 * Every valid event is forwarded to the tracker; `accepted` says whether it maps to a live status
 * (`mapHookPayload`). Unknown events are forwarded too and ignored by `LiveTracker.applyHook`.
 */
export function registerHookRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.post(
    '/api/hooks',
    bodyLimit({
      maxSize: HOOK_BODY_LIMIT_BYTES,
      onError: (c) => c.json(redactedApiError('payload_too_large', 'hook payload too large'), 413),
    }),
    async (c) => {
      const raw: unknown = await c.req.json().catch(() => null);
      const parsed = HookIngestBody.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          redactedApiError('validation_failed', 'invalid hook payload', parsed.error.issues),
          400,
        );
      }
      const fields = pickHookFields(raw);
      if (!fields) return c.json(redactedApiError('validation_failed', 'invalid hook payload'), 400);
      const signal = mapHookPayload(raw);
      ctx.bus.emit({
        type: 'hook.received',
        payload: { sessionId: fields.sessionId, event: fields.event },
      });
      ctx.live?.applyHook({
        sessionId: fields.sessionId,
        event: fields.event,
        message: fields.message,
        ts: new Date().toISOString(),
        // Only set when a tool is known, so an event without one carries the same four keys as before.
        ...(signal?.currentTool ? { tool: signal.currentTool } : {}),
      });
      return c.json({ ok: true as const, accepted: signal !== null });
    },
  );
}
