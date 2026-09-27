import { randomUUID } from 'node:crypto';
import { AutomationInput, AutomationSettingsPatch, Suggestion } from '@orc/api-contract';
import { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { parseWith, readJson } from '../json.ts';
import { whoOf } from '../p6-util.ts';
import { ConfirmBody, need, requireConfirmed } from '../p7-guard.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';

const EnabledBody = z.object({ enabled: z.boolean() });
const SuggestionQuery = z.object({ state: Suggestion.shape.state.optional() });

/**
 * P7 automations and suggestions. Both services are optional on `ctx` (set by `createPhase7`);
 * while unset every route answers `409 not_enabled`. Automation rows are user-authored config and
 * are round-tripped by the editor, so they go out as-is; runs, run logs and suggestions carry
 * Claude output, Linear titles or source lines, and go out through `redactedJson`.
 */
export function registerAutomationRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.automations, 'automations');
  const sugg = () => need(ctx.suggestions, 'suggestions');

  const automationOr404 = (id: string) => {
    const a = svc().get(id);
    if (!a) throw new ServiceError('not_found', 404, `automation ${id} not found`);
    return a;
  };
  const runOr404 = (runId: string) => {
    const r = svc().run(runId);
    if (!r) throw new ServiceError('not_found', 404, `automation run ${runId} not found`);
    return r;
  };
  const suggestionOr404 = (id: string) => {
    const s = sugg().get(id);
    if (!s) throw new ServiceError('not_found', 404, `suggestion ${id} not found`);
    return s;
  };
  const settingsView = () => {
    const a = ctx.config().automations;
    return { enabled: a.enabled, maxConcurrent: a.maxConcurrent, suggestionsEnabled: a.suggestions.enabled };
  };

  app.get('/api/automations', (c) => c.json(svc().listWithStats()));

  // New automations are always created disabled, whatever the body says.
  app.post('/api/automations', async (c) => {
    const body = await readJson(c, AutomationInput);
    const s = svc();
    const isNew = body.id === undefined || s.get(body.id) === null;
    const saved = s.save({ ...body, id: body.id ?? randomUUID(), enabled: isNew ? false : body.enabled });
    return c.json(saved, isNew ? 201 : 200);
  });

  app.get('/api/automations/settings', (c) => c.json(settingsView()));

  app.patch('/api/automations/settings', async (c) => {
    const patch = await readJson(c, AutomationSettingsPatch);
    const updateConfig = need(ctx.updateConfig, 'config updates');
    updateConfig((cfg) => ({
      ...cfg,
      automations: {
        ...cfg.automations,
        enabled: patch.enabled ?? cfg.automations.enabled,
        maxConcurrent: patch.maxConcurrent ?? cfg.automations.maxConcurrent,
        suggestions: {
          ...cfg.automations.suggestions,
          enabled: patch.suggestionsEnabled ?? cfg.automations.suggestions.enabled,
        },
      },
    }));
    ctx.audit.record({
      ...whoOf(c),
      action: 'settings.update',
      target: 'config:automations',
      params: patch,
      result: 'ok',
      error: null,
    });
    return c.json(settingsView());
  });

  app.get('/api/automations/suggestions', (c) => {
    const q = parseWith(SuggestionQuery, c.req.query());
    return redactedJson(c, sugg().list(q.state));
  });
  app.post('/api/automations/suggestions/refresh', async (c) => c.json(await sugg().refresh()));
  app.post('/api/automations/suggestions/:id/accept', async (c) => {
    const body = await readJson(c, ConfirmBody);
    const s = suggestionOr404(c.req.param('id'));
    requireConfirmed(body, `Start a Claude session for "${s.title}"`, { suggestion: s });
    return c.json(await sugg().accept(s.id));
  });
  app.post('/api/automations/suggestions/:id/dismiss', (c) => {
    const s = suggestionOr404(c.req.param('id'));
    return redactedJson(c, sugg().dismiss(s.id));
  });

  app.get('/api/automations/runs/:runId', (c) => redactedJson(c, runOr404(c.req.param('runId'))));
  app.get('/api/automations/runs/:runId/log', (c) => {
    const run = runOr404(c.req.param('runId'));
    return redactedJson(c, { lines: svc().logLines(run.id) });
  });
  // 202 with the run in `running` (or its denial); the implementation continues in the background.
  app.post('/api/automations/runs/:runId/approve', async (c) => {
    const body = await readJson(c, ConfirmBody);
    const run = runOr404(c.req.param('runId'));
    if (run.status !== 'awaiting_approval') {
      throw new ServiceError(
        'invalid_state',
        409,
        `run ${run.id} is not awaiting plan approval (status ${run.status})`,
      );
    }
    const a = automationOr404(run.automationId);
    requireConfirmed(
      body,
      `Approve the plan and let "${a.name}" implement it. It cannot merge, deploy or touch production.`,
      { plan: run.summary },
    );
    svc()
      .approve(run.id)
      .catch((err: unknown) => ctx.log.warn({ err, runId: run.id }, 'automation approval failed'));
    return redactedJson(c, runOr404(run.id), 202);
  });
  app.post('/api/automations/runs/:runId/reject', (c) =>
    redactedJson(c, svc().reject(runOr404(c.req.param('runId')).id)),
  );
  app.post('/api/automations/runs/:runId/rerun', async (c) => {
    const r = await svc().rerun(runOr404(c.req.param('runId')).id);
    return r ? redactedJson(c, r, 202) : c.json({ deduped: true as const });
  });

  app.get('/api/automations/:id', (c) => {
    const id = c.req.param('id');
    const a = svc().getWithStats(id);
    if (!a) throw new ServiceError('not_found', 404, `automation ${id} not found`);
    return c.json(a);
  });
  app.delete('/api/automations/:id', async (c) => {
    const body = await readJson(c, ConfirmBody);
    const a = automationOr404(c.req.param('id'));
    requireConfirmed(body, `Delete the automation "${a.name}" and its run history`);
    svc().remove(a.id);
    return c.json({ ok: true as const });
  });
  app.post('/api/automations/:id/enabled', async (c) => {
    const { enabled } = await readJson(c, EnabledBody);
    const a = automationOr404(c.req.param('id'));
    return c.json(svc().setEnabled(a.id, enabled));
  });
  app.post('/api/automations/:id/run', async (c) => {
    const a = automationOr404(c.req.param('id'));
    const r = await svc().start(a.id, { key: `manual:${randomUUID()}`, source: 'manual', vars: {} });
    if (!r) throw new ServiceError('invalid_state', 409, 'manual run was not created');
    return redactedJson(c, r, 202);
  });
  app.get('/api/automations/:id/runs', (c) =>
    redactedJson(c, svc().runs(automationOr404(c.req.param('id')).id)),
  );
}
