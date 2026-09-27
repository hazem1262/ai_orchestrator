import { GoalPutBody, GoalsListQuery, GoalTargetTypeSchema } from '@orc/api-contract';
import type { GoalState } from '@orc/core';
import type { Context } from 'hono';
import type { DaemonContext } from '../../context.ts';
import { need } from '../../services/need.ts';
import { parseStates, readBody, readQuery } from '../p5-util.ts';
import { redactedApiError } from '../redact-out.ts';
import { redactedJson } from '../redacted-json.ts';
import type { OrcApp } from '../types.ts';

const STATES: readonly GoalState[] = ['active', 'paused', 'blocked', 'complete'];

export function registerGoalRoutes(app: OrcApp, ctx: DaemonContext): void {
  const svc = () => need(ctx.goals, 'goals');
  const badTarget = (c: Context) =>
    c.json(redactedApiError('validation_failed', 'targetType must be session or stream'), 400);

  // Objectives and the prefill come from session prompts, names and stream titles, so every body
  // that carries them goes out through redactedJson.
  app.get('/api/goals', (c) => {
    const q = readQuery(c, GoalsListQuery);
    if (!q.ok) return q.res;
    return redactedJson(c, svc().list({ state: parseStates(q.data.state, STATES) }));
  });
  app.get('/api/goals/:targetType/:targetId', (c) => {
    const t = GoalTargetTypeSchema.safeParse(c.req.param('targetType'));
    if (!t.success) return badTarget(c);
    const id = c.req.param('targetId');
    return redactedJson(c, { goal: svc().get(t.data, id), prefill: svc().prefill(t.data, id) });
  });
  app.put('/api/goals/:targetType/:targetId', async (c) => {
    const t = GoalTargetTypeSchema.safeParse(c.req.param('targetType'));
    if (!t.success) return badTarget(c);
    const b = await readBody(c, GoalPutBody);
    if (!b.ok) return b.res;
    return redactedJson(c, svc().set({ targetType: t.data, targetId: c.req.param('targetId'), ...b.data }));
  });
}
