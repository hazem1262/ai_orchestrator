import { PlanApproveBody, PlanRejectBody } from '@orc/api-contract';
import type { Hono } from 'hono';
import type { DaemonContext } from '../../context.ts';
import { ServiceError } from '../../services/errors.ts';
import type { PlanApprovalService } from '../../services/review/plan-approval.ts';
import { parseJson, phase4App, requireConfirm } from './git-guard.ts';

export function planRoutes(ctx: DaemonContext): Hono {
  const app = phase4App();
  const plans = (): PlanApprovalService => {
    if (!ctx.plans) throw new ServiceError('unavailable', 503, 'plan approval service is not running');
    return ctx.plans;
  };
  const pkOf = (source: string, id: string) => {
    if (source !== 'claude')
      throw new ServiceError('validation_failed', 400, 'plan approval is only available for Claude sessions');
    return `${source}:${id}`;
  };

  app.post('/sessions/:source/:id/plan/approve', async (c) => {
    const b = await parseJson(c, PlanApproveBody);
    const pk = pkOf(c.req.param('source'), c.req.param('id'));
    requireConfirm(b.confirm, 'Approve the plan and let the agent start implementing');
    await plans().approve(pk);
    return c.json({ ok: true });
  });

  app.post('/sessions/:source/:id/plan/reject', async (c) => {
    const b = await parseJson(c, PlanRejectBody);
    const pk = pkOf(c.req.param('source'), c.req.param('id'));
    requireConfirm(b.confirm, 'Reject the plan and send your feedback to the agent');
    await plans().reject(pk, b.feedback);
    return c.json({ ok: true });
  });

  return app;
}
