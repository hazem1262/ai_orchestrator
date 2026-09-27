import { BudgetUpsertBody } from '@orc/api-contract';
import type { Source } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { deleteBudget, upsertBudget } from '../../db/repos/budgets.ts';
import { need } from '../../services/need.ts';
import { sessionPk } from '../../services/sessions.ts';
import { readBody } from '../p5-util.ts';
import { redactedApiError } from '../redact-out.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';

const SOURCES = new Set<string>(['claude', 'codex', 'agnc']);
const OFFICIAL_MAX_BYTES = 64_000;

export function registerUsageRoutes(app: OrcApp, ctx: DaemonContext): void {
  const meter = () => need(ctx.usage, 'usage');

  app.get('/api/usage', (c) => c.json(meter().snapshot()));
  app.get('/api/usage/budgets', (c) => c.json(meter().budgets()));
  app.put('/api/usage/budgets', async (c) => {
    const body = await readBody(c, BudgetUpsertBody);
    if (!body.ok) return body.res;
    const b = upsertBudget(ctx.db, body.data, new Date().toISOString());
    meter().refresh();
    return c.json(b);
  });
  app.delete('/api/usage/budgets/:id', (c) => {
    const id = c.req.param('id');
    if (id.startsWith('config:')) {
      return c.json(
        redactedApiError('config_budget', 'Budgets from project config are edited in Settings → Projects'),
        409,
      );
    }
    if (!deleteBudget(ctx.db, id)) return c.json(redactedApiError('not_found', 'budget not found'), 404);
    meter().refresh();
    return c.json({ ok: true as const });
  });
  app.get('/api/usage/concurrency', (c) => c.json(meter().concurrency()));
  app.get('/api/usage/context/:source/:id', (c) => {
    const source = c.req.param('source');
    if (!SOURCES.has(source)) return c.json(redactedApiError('validation_failed', 'unknown source'), 400);
    return redactedJson(c, meter().contextFill(sessionPk(source as Source, c.req.param('id'))));
  });
  app.post('/api/usage/official', async (c) => {
    const text = await c.req.text();
    if (text.length > OFFICIAL_MAX_BYTES) {
      return c.json(redactedApiError('payload_too_large', 'statusline payload too large'), 400);
    }
    try {
      meter().ingestOfficial(JSON.parse(text));
    } catch {
      // Not JSON: ignored. The statusline must never fail because of the daemon.
    }
    return c.body(null, 204);
  });
}
