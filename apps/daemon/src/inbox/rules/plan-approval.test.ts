import type { TimelineEvent } from '@orc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/helpers.ts';
import { makeSession, recordingInbox, stubSessions } from '../../../test/stubs.ts';
import { inboxDedupeKey } from '../dedupe-key.ts';
import { createPlanApprovalRule } from './plan-approval.ts';

const planScope = (pk: string) => ({ session: pk }) as const;
const planItemKey = (pk: string) => inboxDedupeKey({ kind: 'plan_approval', scope: planScope(pk) });

const ev = (seq: number, p: Partial<TimelineEvent>): TimelineEvent => ({
  sessionId: 'p1',
  agentId: null,
  uuid: `u${seq}`,
  parentUuid: null,
  seq,
  ts: '2026-09-17T10:00:00Z',
  kind: 'assistant_text',
  turn: 1,
  text: null,
  tool: null,
  toolUseId: null,
  mcpServer: null,
  input: null,
  messageId: null,
  model: null,
  usage: null,
  durationMs: null,
  ...p,
});

let ctxs: TestContext[] = [];
afterEach(() => {
  for (const c of ctxs) c.dispose();
  ctxs = [];
});

function setup(events: TimelineEvent[]) {
  const inbox = recordingInbox();
  const base = stubSessions([makeSession({ id: 'p1', projectId: 'wakecap', tickets: ['SAF-80'] })]);
  const calls: Array<number | undefined> = [];
  const sessions = {
    ...base,
    events: (_s: string, _id: string, opts: { afterSeq?: number; limit?: number }) => {
      calls.push(opts.afterSeq);
      const items = events.filter((e) => e.seq > (opts.afterSeq ?? -1)).slice(0, opts.limit ?? 500);
      return { items, nextSeq: items.length === (opts.limit ?? 500) ? (items.at(-1)?.seq ?? null) : null };
    },
  };
  const ctx = createTestContext({ inbox, sessions });
  ctxs.push(ctx);
  const plans: string[] = [];
  ctx.bus.on('plan.pending', (e) => plans.push(e.plan));
  const rule = createPlanApprovalRule();
  return { ctx, inbox, rule, calls, plans, events };
}

describe('plan approval rule', () => {
  it('opens an item when the session waits on ExitPlanMode and resolves it when it moves on', () => {
    const { ctx, inbox, rule, plans } = setup([
      ev(1, { kind: 'prompt', text: 'plan it' }),
      ev(2, {
        kind: 'tool_call',
        tool: 'ExitPlanMode',
        toolUseId: 'tu-plan',
        input: { plan: '1. Do X\n2. token ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      }),
    ]);
    rule.handle({ type: 'session.statusChanged', pk: 'claude:p1', from: 'busy', to: 'waiting' }, ctx);
    // Superseded call shape: the plan's `dedupeKey: 'plan:claude:p1'` becomes kind + session scope.
    expect(inbox.upserts[0]).toMatchObject({
      kind: 'plan_approval',
      scope: planScope('claude:p1'),
      sessionId: 'claude:p1',
      projectId: 'wakecap',
      ticket: 'SAF-80',
      reason: 'Plan awaiting approval',
      payload: {
        source: 'claude',
        id: 'p1',
        toolUseId: 'tu-plan',
        plan: '1. Do X\n2. token «redacted:github»',
      },
    });
    expect(plans).toEqual(['1. Do X\n2. token «redacted:github»']);
    rule.handle({ type: 'session.statusChanged', pk: 'claude:p1', from: 'waiting', to: 'busy' }, ctx);
    expect(inbox.resolved).toEqual([planItemKey('claude:p1')]);
  });

  it('ignores waits that are not about a plan and plans that were already answered', () => {
    const { ctx, inbox, rule, events } = setup([ev(1, { kind: 'tool_call', tool: 'Bash', toolUseId: 'b1' })]);
    rule.handle({ type: 'session.statusChanged', pk: 'claude:p1', from: 'busy', to: 'waiting' }, ctx);
    events.push(ev(2, { kind: 'tool_call', tool: 'ExitPlanMode', toolUseId: 'tu2', input: { plan: 'p' } }));
    events.push(ev(3, { kind: 'tool_result', toolUseId: 'tu2' }));
    rule.handle({ type: 'session.statusChanged', pk: 'claude:p1', from: 'busy', to: 'waiting' }, ctx);
    expect(inbox.upserts).toEqual([]);
    expect(rule.pending('claude:p1')).toBeNull();
  });

  it('reads the transcript incrementally', () => {
    const { ctx, rule, calls, events } = setup([ev(1, { kind: 'prompt' })]);
    rule.handle({ type: 'session.statusChanged', pk: 'claude:p1', from: 'busy', to: 'waiting' }, ctx);
    events.push(
      ev(2, { kind: 'tool_call', tool: 'ExitPlanMode', toolUseId: 'tu3', input: { plan: 'later' } }),
    );
    rule.handle({ type: 'session.statusChanged', pk: 'claude:p1', from: 'busy', to: 'waiting' }, ctx);
    expect(calls).toEqual([undefined, 1]);
    expect(rule.pending('claude:p1')?.plan).toBe('later');
  });
});
