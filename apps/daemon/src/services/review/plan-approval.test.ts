import type { LiveState } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { recordingPty } from '../../../test/fake-pty.ts';
import { createTestContext, type TestContext } from '../../../test/helpers.ts';
import { makeSession, memoryAudit, recordingInbox, stubSessions } from '../../../test/stubs.ts';
import { inboxDedupeKey } from '../../inbox/dedupe-key.ts';
import { createPlanApprovalService } from './plan-approval.ts';
import { PLAN_KEYS, rejectionPrompt } from './plan-keys.ts';

// Superseded call shape: the plan's `planKey(pk)` helper is gone; the item is kind + session scope.
const planScope = (pk: string) => ({ session: pk }) as const;
const planItemKey = (pk: string) => inboxDedupeKey({ kind: 'plan_approval', scope: planScope(pk) });

const live = (ownership: LiveState['ownership']): LiveState => ({
  pid: 1,
  status: 'waiting',
  waitingFor: 'plan approval',
  since: '2026-09-17T10:00:00Z',
  ownership,
  ptyId: ownership === 'owned' ? 'pty-plan' : null,
  stage: null,
  currentTool: 'ExitPlanMode',
  backgroundJobs: 0,
  runningSubagents: 0,
  contextFill: null,
});

let ctxs: TestContext[] = [];
afterEach(() => {
  for (const c of ctxs) c.dispose();
  ctxs = [];
});

function setup(withItem = true) {
  const inbox = recordingInbox();
  const pty = recordingPty();
  const audit = memoryAudit();
  const sessions = stubSessions([
    makeSession({ id: 'own', live: live('owned') }),
    makeSession({ id: 'obs', live: live('observed') }),
  ]);
  const ctx = createTestContext({ inbox, pty, audit, sessions });
  ctxs.push(ctx);
  if (withItem) {
    inbox.upsert({ kind: 'plan_approval', scope: planScope('claude:own'), reason: 'Plan awaiting approval' });
    inbox.upsert({ kind: 'plan_approval', scope: planScope('claude:obs'), reason: 'Plan awaiting approval' });
  }
  return { svc: createPlanApprovalService(ctx), inbox, pty, audit };
}

describe('PlanApprovalService', () => {
  it('approves an owned session by selecting the approve option', async () => {
    const { svc, inbox, pty, audit } = setup();
    await svc.approve('claude:own');
    expect(pty.writes).toEqual([{ id: 'pty-plan', data: PLAN_KEYS.approve }]);
    expect(inbox.resolved).toEqual([planItemKey('claude:own')]);
    expect(audit.entries.at(-1)).toMatchObject({
      action: 'plan.approve',
      target: 'claude:own',
      result: 'ok',
    });
  });

  it('rejects with feedback: dismisses the dialog, then sends the feedback', async () => {
    const { svc, pty, audit } = setup();
    await svc.reject('claude:own', 'Split step 2 into two PRs');
    expect(pty.writes).toEqual([{ id: 'pty-plan', data: PLAN_KEYS.reject }]);
    expect(pty.texts).toEqual([{ id: 'pty-plan', text: rejectionPrompt('Split step 2 into two PRs') }]);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'plan.reject', result: 'ok' });
  });

  it('refuses observed sessions and sessions with no pending plan', async () => {
    await expect(setup().svc.approve('claude:obs')).rejects.toMatchObject({ code: 'not_owned' });
    await expect(setup(false).svc.approve('claude:own')).rejects.toMatchObject({ code: 'no_pending_plan' });
  });
});
