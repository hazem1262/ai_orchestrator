import { InboxKindSchema, NotificationPrefs, type OrcConfig } from '@orc/api-contract';
import type { Env, Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';
import { DEFAULT_NOTIFY_PREFS } from '../../notify/notifier.ts';
import { redactedApiError } from '../redact-out.ts';

const KINDS = new Set<string>(InboxKindSchema.options);

export function effectivePrefs(cfg: OrcConfig): NotificationPrefs {
  const out: NotificationPrefs = {};
  for (const [k, v] of Object.entries(DEFAULT_NOTIFY_PREFS)) {
    if (v) out[k] = { enabled: v.enabled, channels: [...v.channels] };
  }
  return { ...out, ...cfg.notifications };
}

/**
 * Error bodies are built here through `redactedApiError`, so the routes answer the same way
 * whether or not the app they are mounted on has the daemon's `onError`.
 */
export function registerNotificationRoutes<E extends Env>(app: Hono<E>, ctx: DaemonContext): void {
  app.get('/api/config/notifications', (c) => c.json(effectivePrefs(ctx.config())));

  app.put('/api/config/notifications', async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json(redactedApiError('validation_failed', 'request body must be JSON'), 400);
    }
    const parsed = NotificationPrefs.safeParse(raw);
    if (!parsed.success)
      return c.json(
        redactedApiError('validation_failed', 'invalid notification preferences', parsed.error.issues),
        400,
      );
    const unknown = Object.keys(parsed.data).filter((k) => !KINDS.has(k));
    if (unknown.length > 0)
      return c.json(redactedApiError('validation_failed', `unknown inbox kinds: ${unknown.join(', ')}`), 400);
    if (!ctx.updateConfig)
      return c.json(redactedApiError('config_readonly', 'config cannot be updated'), 503);
    const next = ctx.updateConfig((cur) => ({ ...cur, notifications: parsed.data }));
    return c.json(effectivePrefs(next));
  });
}
