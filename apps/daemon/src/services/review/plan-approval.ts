import type { DaemonContext } from '../../context.ts';
import { inboxDedupeKey } from '../../inbox/dedupe-key.ts';
import { runAudited } from '../git/audit.ts';
import { GitError } from '../git/exec.ts';
import { PLAN_KEYS, rejectionPrompt } from './plan-keys.ts';
import { isOwned } from './review.ts';

export interface PlanApprovalService {
  approve(pk: string): Promise<void>;
  reject(pk: string, feedback: string): Promise<void>;
}

/** The inbox identity of a session's pending plan; the engine composes the dedupe key from it. */
const planItem = (pk: string) => ({ kind: 'plan_approval', scope: { session: pk } }) as const;

export function createPlanApprovalService(ctx: DaemonContext): PlanApprovalService {
  function ownedPty(pk: string): string {
    const s = ctx.sessions.getByPk(pk);
    if (!s) throw new GitError('not_found', `session ${pk} not found`);
    if (!isOwned(s)) throw new GitError('not_owned', 'plans can only be answered for sessions the app owns');
    const composed = inboxDedupeKey(planItem(pk));
    const pending = ctx.inbox
      ?.list({ state: ['open', 'snoozed'], kind: ['plan_approval'] })
      .some((i) => i.dedupeKey === composed);
    if (!pending) throw new GitError('no_pending_plan', `no plan is waiting for approval in ${pk}`);
    return s.live.ptyId;
  }

  return {
    async approve(pk) {
      const ptyId = ownedPty(pk);
      await runAudited(ctx, 'user', 'plan.approve', pk, { ptyId }, async () => {
        ctx.pty.write(ptyId, PLAN_KEYS.approve);
      });
      ctx.inbox?.resolve(planItem(pk));
    },
    async reject(pk, feedback) {
      const ptyId = ownedPty(pk);
      await runAudited(
        ctx,
        'user',
        'plan.reject',
        pk,
        { ptyId, feedbackChars: feedback.length },
        async () => {
          ctx.pty.write(ptyId, PLAN_KEYS.reject);
          await new Promise((r) => setTimeout(r, PLAN_KEYS.rejectSettleMs));
          await ctx.pty.sendText(ptyId, rejectionPrompt(feedback));
        },
      );
      ctx.inbox?.resolve(planItem(pk));
    },
  };
}
