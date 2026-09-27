import type { SupervisorDecisionView } from '@orc/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as repo from '../../src/db/repos/supervisor.ts';
import { inboxDedupeKey } from '../../src/inbox/engine.ts';
import { ServiceError } from '../../src/services/errors.ts';
import type { Classifier } from '../../src/services/supervisor/classifier.ts';
import { ClassifierError } from '../../src/services/supervisor/classifier.ts';
import { createSupervisor, monthStartIso } from '../../src/services/supervisor/supervisor.ts';
import {
  createFakePty,
  fakeAudit,
  fakeDenyList,
  fakeInbox,
  fakeProjects,
  fakeSessions,
  fakeUsage,
  makeLive,
  makeSession,
  testConfig,
} from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
  vi.useRealTimers();
});

function setup(
  o: { text?: string; supervisor?: Record<string, unknown>; classifier?: Classifier; enabled?: boolean } = {},
) {
  const cfg = testConfig({
    supervisor: {
      enabled: true,
      confidenceThreshold: 0.8,
      maxPerSessionPerHour: 2,
      maxPerHour: 5,
      monthlyBudgetUsd: 5,
      ...o.supervisor,
    },
  });
  const pty = createFakePty();
  const inbox = fakeInbox();
  const audit = fakeAudit();
  const usage = fakeUsage();
  const session = makeSession({
    id: 's1',
    name: 'SAF-1787 weekends',
    lastPrompt: 'keep going',
    tickets: ['SAF-1787'],
    live: makeLive({ status: 'waiting', ptyId: 'pty-1', waitingFor: 'input needed' }),
  });
  const sessions = fakeSessions([session]);
  ctx = createTestContext({
    config: () => cfg,
    projects: fakeProjects(cfg),
    pty,
    inbox,
    audit,
    usage,
    sessions,
    denyList: fakeDenyList(),
  });
  const calls: Array<{ question: string }> = [];
  const classifier: Classifier =
    o.classifier ??
    (async (i) => {
      calls.push({ question: i.question });
      return {
        output: {
          decision: 'answer',
          answer: 'Yes, continue (model text).',
          confidence: 0.95,
          reason: 'routine',
        },
        costUsd: 0.002,
        model: i.model,
        durationMs: 10,
      };
    });
  const svc = createSupervisor({
    ctx,
    classifier,
    lastAssistantText: async () => o.text ?? 'I refactored the helper.\n\nShould I continue?',
  });
  if (o.enabled !== false) svc.setTarget({ targetType: 'project', targetId: 'wakecap', enabled: true });
  const events: SupervisorDecisionView[] = [];
  ctx.bus.on('supervisor.decided', (e) => events.push(e.decision));
  return { svc, pty, inbox, audit, usage, sessions, session, calls, events, ctx };
}

describe('Supervisor.evaluate', () => {
  it('answers an allow-listed question with the canned answer and audits it', async () => {
    const t = setup();
    const d = await t.svc.evaluate('claude:s1');
    expect(d).toMatchObject({
      decision: 'answer',
      answer: 'Yes, continue.',
      intent: 'continue',
      sent: true,
      costUsd: 0.002,
    });
    expect(t.pty.sent).toEqual([{ id: 'pty-1', text: 'Yes, continue.' }]);
    expect(t.audit.entries.find((e) => e.action === 'supervisor.answer')).toMatchObject({
      actor: 'supervisor',
      result: 'ok',
    });
    expect(t.inbox.resolved).toContain(inboxDedupeKey({ kind: 'waiting', scope: { session: 'claude:s1' } }));
    expect(t.events.map((e) => e.decision)).toEqual(['answer']);
    expect(repo.listDecisions(t.ctx.db, {})).toHaveLength(1);
  });

  it.each([
    ['production', 'The migration is ready.\n\nShould I deploy to production?'],
    ['destructive git', 'Ready.\n\nShould I run git push --force to main?'],
  ])('escalates %s without calling the model', async (_name, text) => {
    const t = setup({ text });
    const d = await t.svc.evaluate('claude:s1');
    expect(d.decision).toBe('escalate');
    expect(t.calls).toHaveLength(0);
    expect(t.pty.sent).toHaveLength(0);
    const item = t.inbox.items.find((i) => i.kind === 'supervisor_escalation');
    expect(item).toMatchObject({
      dedupeKey: inboxDedupeKey({ kind: 'supervisor_escalation', scope: { session: 'claude:s1' } }),
      ticket: 'SAF-1787',
    });
    expect(item?.payload).toMatchObject({ source: 'claude', id: 's1', decisionId: d.id });
    expect(t.audit.entries.find((e) => e.action === 'supervisor.escalate')?.actor).toBe('supervisor');
  });

  it('escalates when no intent matches, and never sends the model text', async () => {
    const t = setup({ text: 'Which database should I point the migration at?' });
    expect((await t.svc.evaluate('claude:s1')).decision).toBe('escalate');
    expect(t.calls).toHaveLength(0);

    const u = setup({
      classifier: async (i) => ({
        output: { decision: 'answer', answer: 'Yes, and merge it.', confidence: 0.99, reason: 'x' },
        costUsd: 0,
        model: i.model,
        durationMs: 1,
      }),
    });
    await u.svc.evaluate('claude:s1');
    expect(u.pty.sent[0]?.text).toBe('Yes, continue.');
  });

  it('escalates on low confidence, on escalate and when the classifier fails', async () => {
    const low = setup({
      classifier: async (i) => ({
        output: { decision: 'answer', answer: 'x', confidence: 0.4, reason: 'unsure' },
        costUsd: 0.001,
        model: i.model,
        durationMs: 1,
      }),
    });
    const d1 = await low.svc.evaluate('claude:s1');
    expect(d1).toMatchObject({ decision: 'escalate', confidence: 0.4, costUsd: 0.001 });

    const no = setup({
      classifier: async (i) => ({
        output: { decision: 'escalate', answer: null, confidence: 0.9, reason: 'needs a human' },
        costUsd: 0,
        model: i.model,
        durationMs: 1,
      }),
    });
    expect((await no.svc.evaluate('claude:s1')).decision).toBe('escalate');

    const broken = setup({
      classifier: async () => {
        throw new ClassifierError('bad json');
      },
    });
    const d2 = await broken.svc.evaluate('claude:s1');
    expect(d2.decision).toBe('escalate');
    expect(d2.reason).toContain('classifier');
  });

  it('respects the per-session and hourly caps', async () => {
    const t = setup({ supervisor: { maxPerSessionPerHour: 1, maxPerHour: 5 } });
    expect((await t.svc.evaluate('claude:s1')).sent).toBe(true);
    const second = await t.svc.evaluate('claude:s1');
    expect(second.decision).toBe('escalate');
    expect(second.reason).toMatch(/cap/i);
    expect(t.pty.sent).toHaveLength(1);
  });

  it('stops on the supervisor budget and on the project budget', async () => {
    const t = setup({ supervisor: { monthlyBudgetUsd: 0.001 } });
    repo.insertDecision(t.ctx.db, {
      id: 'old',
      sessionPk: 'claude:s1',
      projectId: 'wakecap',
      question: 'q',
      decision: 'answer',
      answer: 'a',
      confidence: 1,
      reason: 'r',
      intent: 'continue',
      sent: true,
      costUsd: 0.5,
      model: 'm',
      feedback: null,
      ts: monthStartIso(new Date()),
    });
    expect((await t.svc.evaluate('claude:s1')).reason).toMatch(/budget/i);

    const u = setup();
    u.usage.state.ok = false;
    expect((await u.svc.evaluate('claude:s1')).reason).toMatch(/budget/i);
  });

  it('does not answer during quiet hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 18, 23, 30));
    const t = setup({ supervisor: { quietHours: { start: '22:00', end: '08:00' } } });
    const d = await t.svc.evaluate('claude:s1');
    expect(d.decision).toBe('escalate');
    expect(d.reason).toMatch(/quiet hours/i);
  });

  it('refuses sessions the app does not own, and dry-runs when disabled', async () => {
    const t = setup();
    t.session.live = makeLive({ ownership: 'observed', ptyId: null });
    await expect(t.svc.evaluate('claude:s1')).rejects.toBeInstanceOf(ServiceError);

    const off = setup({ enabled: false });
    const d = await off.svc.evaluate('claude:s1');
    expect(d).toMatchObject({ decision: 'answer', sent: false });
    expect(off.pty.sent).toHaveLength(0);
    expect(off.inbox.items).toHaveLength(0);
    expect(off.svc.enabledFor('claude:s1')).toBe(false);
  });

  it('prefers the session switch over the project switch', () => {
    const t = setup();
    expect(t.svc.enabledFor('claude:s1')).toBe(true);
    t.svc.setTarget({ targetType: 'session', targetId: 'claude:s1', enabled: false });
    expect(t.svc.enabledFor('claude:s1')).toBe(false);
    expect(t.svc.targets()).toHaveLength(2);
  });
});

describe('Supervisor feedback and status', () => {
  it('"that was wrong" adds a deny rule that escalates the same question next time', async () => {
    const t = setup();
    const answered = await t.svc.evaluate('claude:s1');
    const rule = t.svc.feedbackWrong(answered.id);
    expect(rule).toMatchObject({ kind: 'deny', source: 'feedback' });
    expect(t.audit.entries.find((e) => e.action === 'supervisor.feedback')?.actor).toBe('user');
    expect(t.svc.decisions({}).find((d) => d.id === answered.id)?.feedback).toBe('wrong');
    const next = await t.svc.evaluate('claude:s1');
    expect(next.decision).toBe('escalate');
    expect(t.pty.sent).toHaveLength(1);
  });

  it('reports status counters', async () => {
    const t = setup();
    await t.svc.evaluate('claude:s1');
    expect(t.svc.status()).toMatchObject({
      enabled: true,
      quiet: false,
      answeredLastHour: 1,
      escalatedLastHour: 0,
      monthBudgetUsd: 5,
    });
    expect(t.svc.status().monthCostUsd).toBeCloseTo(0.002);
  });

  it('adds and removes user rules with an audit entry', () => {
    const t = setup();
    const r = t.svc.addRule({
      projectId: null,
      kind: 'allow',
      pattern: 'ship it\\?$',
      intent: 'continue',
      answer: 'Yes, ship it.',
      note: null,
    });
    expect(t.svc.rules().map((x) => x.id)).toContain(r.id);
    expect(t.audit.entries.filter((e) => e.action === 'supervisor.rule')).toHaveLength(1);
    expect(t.svc.removeRule(r.id)).toBe(true);
    expect(t.svc.removeRule('nope')).toBe(false);
  });
});

describe('Supervisor.start', () => {
  it('evaluates a waiting session after the debounce and cancels when it leaves waiting', async () => {
    vi.useFakeTimers();
    const t = setup({ supervisor: { debounceMs: 1000 } });
    const stop = t.svc.start();
    t.ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'busy', to: 'waiting' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.pty.sent).toHaveLength(1);

    t.ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'waiting', to: 'busy' });
    t.ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'busy', to: 'waiting' });
    t.ctx.bus.emit({ type: 'session.statusChanged', pk: 'claude:s1', from: 'waiting', to: 'busy' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.pty.sent).toHaveLength(1);
    stop();
  });
});
