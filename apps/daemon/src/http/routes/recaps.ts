import { DailyRecapBody, DailyRecapQuery, RecapRunBody } from '@orc/api-contract';
import type { Source } from '@orc/core';
import type { Context } from 'hono';
import type { DaemonContext } from '../../context.ts';
import { need } from '../../services/need.ts';
import { sessionPk } from '../../services/sessions.ts';
import { readBody, readQuery, sendError } from '../p5-util.ts';
import { redactedApiError } from '../redact-out.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';

const SOURCES: readonly Source[] = ['claude', 'codex', 'agnc'];

export function pkFromParams(c: Context): string | null {
  const source = c.req.param('source');
  const id = c.req.param('id');
  if (!source || !id || !(SOURCES as readonly string[]).includes(source)) return null;
  return sessionPk(source as Source, id);
}

export function registerRecapRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.recaps, 'recaps');
  const badSource = (c: Context) => c.json(redactedApiError('validation_failed', 'unknown source'), 400);

  // Recap text is model output over a transcript digest, so every body that carries it goes out
  // through redactedJson. The spend figures are numbers only.
  app.get('/api/recaps/session/:source/:id', (c) => {
    const pk = pkFromParams(c);
    return pk ? redactedJson(c, svc().latest(pk)) : badSource(c);
  });
  app.post('/api/recaps/session/:source/:id', async (c) => {
    const pk = pkFromParams(c);
    if (!pk) return badSource(c);
    const b = await readBody(c, RecapRunBody);
    if (!b.ok) return b.res;
    try {
      return redactedJson(c, await svc().recap(pk, { onDemand: b.data.onDemand }));
    } catch (err) {
      return sendError(c, err);
    }
  });
  app.get('/api/recaps/daily', (c) => {
    const q = readQuery(c, DailyRecapQuery);
    if (!q.ok) return q.res;
    return redactedJson(c, svc().latestDaily(q.data.projectId, q.data.date));
  });
  app.post('/api/recaps/daily', async (c) => {
    const b = await readBody(c, DailyRecapBody);
    if (!b.ok) return b.res;
    try {
      return redactedJson(c, { text: await svc().daily(b.data.projectId, b.data.date) });
    } catch (err) {
      return sendError(c, err);
    }
  });
  app.get('/api/recaps/spend', (c) => c.json(svc().monthSpend()));
}
