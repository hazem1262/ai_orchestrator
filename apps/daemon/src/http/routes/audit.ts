import { AuditQuery } from '@orc/api-contract';
import { redactDeep } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { redactedApiError } from '../redact-out.ts';
import type { OrcApp } from '../types.ts';

export function registerAuditRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/audit', (c) => {
    const parsed = AuditQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(redactedApiError('validation_failed', 'invalid audit query', parsed.error.issues), 400);
    }
    return c.json(redactDeep(ctx.audit.list(parsed.data)));
  });
}
