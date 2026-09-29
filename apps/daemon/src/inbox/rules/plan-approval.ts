import { redact, type Source } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import type { InboxRule } from '../engine.ts';

export interface PendingPlan {
  toolUseId: string;
  plan: string;
}

const PAGE = 500;
const MAX_PLAN_CHARS = 20_000;

/** The inbox identity of a session's pending plan; the engine composes the dedupe key from it. */
const planItem = (pk: string) => ({ kind: 'plan_approval', scope: { session: pk } }) as const;

const splitSessionPk = (pk: string) => {
  const idx = pk.indexOf(':');
  return { source: pk.slice(0, idx) as Source, id: pk.slice(idx + 1) };
};

/**
 * Opens a `plan_approval` item when a session goes `waiting` on an unanswered ExitPlanMode call,
 * and resolves it when the session leaves `waiting`. The transcript is read incrementally: each
 * session keeps a cursor at the last seq it has seen.
 */
export function createPlanApprovalRule(): InboxRule & { pending(pk: string): PendingPlan | null } {
  const cursor = new Map<string, number>();
  const pendingByPk = new Map<string, PendingPlan | null>();

  function scan(ctx: DaemonContext, pk: string): PendingPlan | null {
    const { source, id } = splitSessionPk(pk);
    let pending = pendingByPk.get(pk) ?? null;
    let after = cursor.get(pk);
    for (;;) {
      const page = ctx.sessions.events(source, id, {
        ...(after === undefined ? {} : { afterSeq: after }),
        limit: PAGE,
      });
      for (const e of page.items) {
        after = e.seq;
        if (e.kind === 'tool_call' && e.tool === 'ExitPlanMode' && e.toolUseId) {
          const input = e.input as { plan?: unknown } | null;
          const plan = typeof input?.plan === 'string' ? input.plan : '';
          pending = { toolUseId: e.toolUseId, plan: redact(plan).slice(0, MAX_PLAN_CHARS) };
        } else if (e.kind === 'tool_result' && pending && e.toolUseId === pending.toolUseId) {
          pending = null;
        }
      }
      if (page.nextSeq === null || page.items.length === 0) break;
    }
    if (after !== undefined) cursor.set(pk, after);
    pendingByPk.set(pk, pending);
    return pending;
  }

  return {
    name: 'plan-approval',
    on: ['session.statusChanged'],
    pending: (pk) => pendingByPk.get(pk) ?? null,
    handle(e, ctx) {
      if (e.type !== 'session.statusChanged' || !ctx.inbox) return;
      if (e.to !== 'waiting') {
        if (e.from === 'waiting') ctx.inbox.resolve(planItem(e.pk));
        return;
      }
      const plan = scan(ctx, e.pk);
      if (!plan) return;
      const s = ctx.sessions.getByPk(e.pk);
      const { source, id } = splitSessionPk(e.pk);
      ctx.inbox.upsert({
        ...planItem(e.pk),
        sessionId: e.pk,
        projectId: s?.projectId ?? null,
        ticket: s?.tickets[0] ?? null,
        reason: 'Plan awaiting approval',
        payload: {
          source,
          id,
          toolUseId: plan.toolUseId,
          plan: plan.plan,
          owned: s?.live?.ownership === 'owned',
        },
      });
      ctx.bus.emit({ type: 'plan.pending', pk: e.pk, plan: plan.plan, toolUseId: plan.toolUseId });
    },
  };
}
