import { ResumeFreshBody } from '@orc/api-contract';
import { redact } from '@orc/core';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { DaemonContext } from '../../context.ts';
import { LaunchError } from '../../services/launch.ts';
import { need } from '../../services/need.ts';
import { confirmationRequired, notFound, readBody, sendError } from '../p5-util.ts';
import { redactedApiError } from '../redact-out.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';
import { pkFromParams } from './recaps.ts';

export function registerHandoffRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.handoffs, 'handoffs');
  const badSource = (c: Context) => c.json(redactedApiError('validation_failed', 'unknown source'), 400);

  // Handoff text is model output over a transcript digest, so every body that carries it (the
  // markdown download included) leaves the daemon redacted.
  app.post('/api/handoffs/session/:source/:id', async (c) => {
    const pk = pkFromParams(c);
    if (!pk) return badSource(c);
    try {
      return redactedJson(c, await svc().generate(pk));
    } catch (err) {
      return sendError(c, err);
    }
  });
  app.get('/api/handoffs/session/:source/:id', (c) => {
    const pk = pkFromParams(c);
    if (!pk) return badSource(c);
    const h = svc().latest(pk);
    return redactedJson(c, h ? { handoff: h, markdown: svc().toMarkdown(h) } : null);
  });
  app.get('/api/handoffs/:id/markdown', (c) => {
    const h = svc().get(c.req.param('id'));
    if (!h) return notFound(c, 'handoff');
    c.header('content-type', 'text/markdown; charset=utf-8');
    c.header('content-disposition', `attachment; filename="handoff-${h.id}.md"`);
    return c.body(redact(svc().toMarkdown(h)));
  });
  app.post('/api/handoffs/:id/resume-fresh', async (c) => {
    const b = await readBody(c, ResumeFreshBody);
    if (!b.ok) return b.res;
    const h = svc().get(c.req.param('id'));
    if (!h) return notFound(c, 'handoff');
    if (b.data.confirm !== true) {
      const s = ctx.sessions.getByPk(h.sessionId);
      return confirmationRequired(c, {
        handoffId: h.id,
        sessionPk: h.sessionId,
        cwd: s?.startCwd ?? null,
        promptPreview: svc().toMarkdown(h).slice(0, 300),
      });
    }
    try {
      return c.json(await svc().resumeFresh(h.id));
    } catch (err) {
      if (err instanceof LaunchError) {
        return c.json(
          redactedApiError(err.code, err.message, err.details),
          err.status as ContentfulStatusCode,
        );
      }
      return sendError(c, err);
    }
  });
}
