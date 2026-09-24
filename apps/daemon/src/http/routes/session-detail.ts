import { RawQuery, SourceParam } from '@orc/api-contract';
import type { Source } from '@orc/core';
import type { Context } from 'hono';
import type { DaemonContext } from '../../context.ts';
import {
  createSessionDetailService,
  type SessionDetailService,
} from '../../services/session-detail/detail.ts';
import { readJsonlPage } from '../../services/session-detail/raw.ts';
import { redactedApiError } from '../redact-out.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';

export function sessionParams(c: Context): { source: Source; id: string } | null {
  const s = SourceParam.safeParse(c.req.param('source'));
  const id = String(c.req.param('id') ?? '');
  return s.success && id ? { source: s.data, id } : null;
}

const notFound = (c: Context, what = 'session') =>
  c.json(redactedApiError('not_found', `${what} not found`), 404);

export function registerSessionDetailRoutes(
  app: OrcApp,
  ctx: DaemonContext,
  svc: SessionDetailService = createSessionDetailService(ctx),
): void {
  const handler = (fn: (source: Source, id: string) => unknown | null) => (c: Context) => {
    const p = sessionParams(c);
    if (!p) return notFound(c);
    const body = fn(p.source, p.id);
    return body === null ? notFound(c) : redactedJson(c, body);
  };

  app.get(
    '/api/sessions/:source/:id/stats',
    handler((s, i) => svc.stats(s, i)),
  );
  app.get(
    '/api/sessions/:source/:id/deliverables',
    handler((s, i) => svc.deliverables(s, i)),
  );
  app.get(
    '/api/sessions/:source/:id/files',
    handler((s, i) => svc.files(s, i)),
  );
  app.get(
    '/api/sessions/:source/:id/usage-series',
    handler((s, i) => svc.usageSeries(s, i)),
  );
  app.get(
    '/api/sessions/:source/:id/safety',
    handler((s, i) => svc.safety(s, i)),
  );

  app.get('/api/sessions/:source/:id/raw', async (c) => {
    const p = sessionParams(c);
    if (!p) return notFound(c);
    const q = RawQuery.safeParse(c.req.query());
    if (!q.success)
      return c.json(redactedApiError('validation_failed', 'invalid raw query', q.error.issues), 400);
    const session = ctx.sessions.get(p.source, p.id);
    if (!session) return notFound(c);
    let path = session.transcriptPath;
    if (q.data.agentId) {
      const agent = ctx.sessions.agents(p.source, p.id).find((a) => a.id === q.data.agentId);
      if (!agent) return notFound(c, 'agent');
      path = agent.transcriptPath;
    }
    if (!path?.endsWith('.jsonl')) {
      return c.json(
        redactedApiError(
          'raw_unavailable',
          'transcript is not available as plain JSONL (archived or remote)',
        ),
        409,
      );
    }
    try {
      return redactedJson(c, await readJsonlPage(path, q.data.offset, q.data.limit));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return notFound(c, 'transcript file');
      throw err;
    }
  });
}
