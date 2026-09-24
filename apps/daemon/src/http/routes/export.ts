import { ExportQuery } from '@orc/api-contract';
import { CORE_VERSION } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { buildSessionExport, ExportTooLargeError } from '../../services/export/export-zip.ts';
import { createLinksService, type LinksService } from '../../services/links/links.ts';
import { createPlanFinderFromContext } from '../../services/links/plans.ts';
import {
  createSessionDetailService,
  type SessionDetailService,
} from '../../services/session-detail/detail.ts';
import { redactedApiError } from '../redact-out.ts';
import type { OrcApp } from '../types.ts';
import { sessionParams } from './session-detail.ts';

export function registerExportRoutes(app: OrcApp, ctx: DaemonContext): void {
  // Built on first request, not at registration: the route census builds the app from a stub
  // context that has no `paths`, and the plan finder reads `paths.claudeHome` when it is created.
  let state: { detail: SessionDetailService; links: LinksService } | null = null;
  const get = () => {
    if (!state) {
      state = {
        detail: createSessionDetailService(ctx),
        links: createLinksService(ctx, createPlanFinderFromContext(ctx)),
      };
    }
    return state;
  };

  app.get('/api/sessions/:source/:id/export', async (c) => {
    const p = sessionParams(c);
    if (!p) return c.json(redactedApiError('not_found', 'session not found'), 404);
    const q = ExportQuery.safeParse(c.req.query());
    if (!q.success)
      return c.json(redactedApiError('validation_failed', 'invalid export query', q.error.issues), 400);
    const redact = q.data.redact === 'true';
    if (!redact && q.data.confirm !== 'true') {
      return c.json(
        redactedApiError('confirmation_required', 'an unredacted export needs confirmation', {
          summary: `Export ${p.source}:${p.id} WITHOUT redaction. The ZIP may contain tokens and passwords.`,
        }),
        409,
      );
    }
    try {
      const { detail, links } = get();
      const r = await buildSessionExport(
        // handoffs: wired in Phase 5; the builder is already null-safe.
        {
          sessions: ctx.sessions,
          detail,
          links,
          audit: ctx.audit,
          handoffs: undefined,
          version: CORE_VERSION,
        },
        p.source,
        p.id,
        { redact },
      );
      if (!r) return c.json(redactedApiError('not_found', 'session not found'), 404);
      const body = r.bytes.buffer.slice(
        r.bytes.byteOffset,
        r.bytes.byteOffset + r.bytes.byteLength,
      ) as ArrayBuffer;
      return c.body(body, 200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${r.filename}"`,
        'cache-control': 'no-store',
      });
    } catch (err) {
      if (err instanceof ExportTooLargeError)
        return c.json(redactedApiError('export_too_large', err.message), 413);
      throw err;
    }
  });
}
