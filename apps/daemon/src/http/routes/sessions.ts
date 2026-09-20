import {
  LabelRequestSchema,
  PinRequestSchema,
  ResumeRequestSchema,
  SessionEventsQuerySchema,
  SessionListQuerySchema,
  SourceSchema,
} from '@orc/api-contract';
import { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { sessionPk } from '../../services/sessions.ts';
import { parseWith, readJson } from '../json.ts';
import { redactAgent, redactEvent, redactListItem, redactSession } from '../redact-out.ts';
import type { OrcApp } from '../types.ts';

const Params = z.object({ source: SourceSchema, id: z.string().min(1) });

export function registerSessionRoutes(app: OrcApp, ctx: DaemonContext): void {
  app.get('/api/sessions', (c) => {
    const q = parseWith(SessionListQuerySchema, c.req.query());
    const out = ctx.sessions.list(q);
    return c.json({ items: out.items.map(redactListItem), nextCursor: out.nextCursor });
  });

  app.get('/api/sessions/:source/:id', (c) => {
    const p = parseWith(Params, c.req.param());
    const s = ctx.sessions.get(p.source, p.id);
    if (!s) throw new ServiceError('not_found', 404, `session ${p.source}:${p.id} not found`);
    return c.json(redactSession(s));
  });

  app.get('/api/sessions/:source/:id/events', (c) => {
    const p = parseWith(Params, c.req.param());
    const q = parseWith(SessionEventsQuerySchema, c.req.query());
    const out = ctx.sessions.events(p.source, p.id, {
      agentId: q.agentId ?? null,
      afterSeq: q.afterSeq,
      limit: q.limit,
    });
    return c.json({ items: out.items.map(redactEvent), nextSeq: out.nextSeq });
  });

  app.get('/api/sessions/:source/:id/agents', (c) => {
    const p = parseWith(Params, c.req.param());
    return c.json(ctx.sessions.agents(p.source, p.id).map(redactAgent));
  });

  app.post('/api/sessions/:source/:id/resume', async (c) => {
    const p = parseWith(Params, c.req.param());
    const body = await readJson(c, ResumeRequestSchema);
    return c.json(await ctx.sessions.resume(p.source, p.id, body));
  });

  app.post('/api/sessions/:source/:id/pin', async (c) => {
    const p = parseWith(Params, c.req.param());
    const body = await readJson(c, PinRequestSchema);
    return c.json({ pinned: ctx.userMeta.setPinned(sessionPk(p.source, p.id), body.pinned) });
  });

  app.post('/api/sessions/:source/:id/label', async (c) => {
    const p = parseWith(Params, c.req.param());
    const body = await readJson(c, LabelRequestSchema);
    return c.json({ labels: ctx.userMeta.setLabels(sessionPk(p.source, p.id), body.labels) });
  });

  app.get('/api/labels', (c) => c.json(ctx.userMeta.labels()));
}
