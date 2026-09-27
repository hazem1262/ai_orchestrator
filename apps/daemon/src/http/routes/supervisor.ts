import {
  SupervisorDecisionQuery,
  SupervisorRuleInput,
  SupervisorSettingsPatch,
  SupervisorTarget,
} from '@orc/api-contract';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import { sessionPk } from '../../services/sessions.ts';
import { parseWith, readJson } from '../json.ts';
import { whoOf } from '../p6-util.ts';
import { ConfirmBody, need, requireConfirmed } from '../p7-guard.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';

/**
 * P7 supervisor. `ctx.supervisor` is optional (set by `createPhase7`); while unset every route
 * answers `409 not_enabled`, and `svc()` runs before any body or query is read so that answer
 * wins over a `400`. Decisions carry the agent's question and the canned answer, and rules carry
 * patterns built from those questions, so those bodies go out through `redactedJson`.
 */
export function registerSupervisorRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.supervisor, 'the supervisor');

  app.get('/api/supervisor/status', (c) => c.json(svc().status()));

  app.patch('/api/supervisor/settings', async (c) => {
    const s = svc();
    const patch = await readJson(c, SupervisorSettingsPatch);
    const updateConfig = need(ctx.updateConfig, 'config updates');
    updateConfig((cfg) => ({ ...cfg, supervisor: { ...cfg.supervisor, ...patch } }));
    ctx.audit.record({
      ...whoOf(c),
      action: 'settings.update',
      target: 'config:supervisor',
      params: patch,
      result: 'ok',
      error: null,
    });
    return c.json(s.status());
  });

  app.get('/api/supervisor/targets', (c) => c.json(svc().targets()));
  app.put('/api/supervisor/targets', async (c) => {
    const s = svc();
    return c.json(s.setTarget(await readJson(c, SupervisorTarget)));
  });

  app.get('/api/supervisor/rules', (c) => redactedJson(c, svc().rules()));
  app.post('/api/supervisor/rules', async (c) => {
    const s = svc();
    return redactedJson(c, s.addRule(await readJson(c, SupervisorRuleInput)), 201);
  });
  app.delete('/api/supervisor/rules/:id', async (c) => {
    const s = svc();
    const body = await readJson(c, ConfirmBody);
    const id = c.req.param('id');
    const rule = s.rules().find((r) => r.id === id);
    if (!rule) throw new ServiceError('not_found', 404, `supervisor rule ${id} not found`);
    requireConfirmed(body, `Delete the supervisor ${rule.kind} rule "${rule.pattern}"`);
    s.removeRule(id);
    return c.json({ ok: true as const });
  });

  app.get('/api/supervisor/decisions', (c) => {
    const s = svc();
    return redactedJson(c, s.decisions(parseWith(SupervisorDecisionQuery, c.req.query())));
  });
  app.post('/api/supervisor/decisions/:id/wrong', (c) =>
    redactedJson(c, svc().feedbackWrong(c.req.param('id'))),
  );

  app.post('/api/supervisor/evaluate/:source/:id', async (c) => {
    const s = svc();
    const source = c.req.param('source');
    if (source !== 'claude' && source !== 'codex' && source !== 'agnc') {
      throw new ServiceError('validation_failed', 400, `unknown source ${source}`);
    }
    return redactedJson(c, await s.evaluate(sessionPk(source, c.req.param('id'))));
  });
}
