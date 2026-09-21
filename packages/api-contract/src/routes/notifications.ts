import { z } from 'zod';

/** GET/PUT /api/config/notifications. A record by design: keys are notification-kind ids chosen
 * by config, not client-typed field names, so the strict-request-body rule does not apply to the
 * outer record shape (mirrors `OrcConfig.notifications`'s shape in config.ts). */
export const NotificationPrefs = z.record(
  z.string(),
  z.object({ enabled: z.boolean(), channels: z.array(z.enum(['macos', 'webpush', 'slack_dm'])) }),
);
export type NotificationPrefs = z.output<typeof NotificationPrefs>;
