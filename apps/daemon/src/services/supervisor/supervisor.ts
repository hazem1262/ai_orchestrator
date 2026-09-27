import { randomUUID } from 'node:crypto';
import type {
  SupervisorDecisionView,
  SupervisorRule,
  SupervisorRuleInput,
  SupervisorStatus,
  SupervisorTarget,
} from '@orc/api-contract';
import { checkDenied, redact, type Session } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import * as repo from '../../db/repos/supervisor.ts';
import { actorScope } from '../audit/actor-scope.ts';
import { ServiceError } from '../errors.ts';
import { type Classifier, createClaudeClassifier } from './classifier.ts';
import { buildPendingQuestion, lastAssistantTextFromTranscript, type PendingQuestion } from './question.ts';
import { applyRules, feedbackPattern, inQuietHours, SUPERVISOR_DENY_PATTERNS } from './rules.ts';

export interface SupervisorDeps {
  ctx: DaemonContext;
  /** Production passes none and gets the headless `claude -p` classifier; tests pass a fake. */
  classifier?: Classifier;
  now?: () => Date;
  lastAssistantText?: (s: Session) => Promise<string | null>;
}

/** A superset of contracts §11 `Supervisor`. */
export interface SupervisorImpl {
  evaluate(sessionPk: string): Promise<SupervisorDecisionView>;
  enabledFor(sessionPk: string): boolean;
  start(): () => void;
  setTarget(t: SupervisorTarget): SupervisorTarget;
  targets(): SupervisorTarget[];
  rules(): SupervisorRule[];
  addRule(r: SupervisorRuleInput): SupervisorRule;
  removeRule(id: string): boolean;
  decisions(q: { sessionPk?: string; limit?: number }): SupervisorDecisionView[];
  feedbackWrong(decisionId: string): SupervisorRule;
  status(): SupervisorStatus;
}

const HOUR_MS = 3_600_000;

export function monthStartIso(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

interface EscalateOpts {
  intent?: SupervisorDecisionView['intent'];
  confidence?: number;
  costUsd?: number | null;
  model?: string | null;
  dryRun?: boolean;
}

/**
 * Answers routine questions from owned, waiting sessions with a canned answer (never the model's
 * free text), within caps, budgets and quiet hours, and escalates everything else to the inbox.
 * It sends input only through the audited PTY path, attributed to the `supervisor` actor.
 */
export function createSupervisor(deps: SupervisorDeps): SupervisorImpl {
  const { ctx } = deps;
  const now = deps.now ?? (() => new Date());
  const cfg = () => ctx.config().supervisor;
  const classifier =
    deps.classifier ??
    createClaudeClassifier({ command: ctx.config().resumeProfile.claudeCommand, cwd: ctx.paths.orcHome });
  const lastAssistantText =
    deps.lastAssistantText ??
    (async (s: Session) => (s.transcriptPath ? lastAssistantTextFromTranscript(s.transcriptPath) : null));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function owned(s: Session | null): s is Session & { live: { ptyId: string } } {
    return !!s?.live && s.live.ownership === 'owned' && !!s.live.ptyId;
  }

  function enabledFor(sessionPk: string): boolean {
    if (!cfg().enabled) return false;
    const s = ctx.sessions.getByPk(sessionPk);
    if (!owned(s)) return false;
    const session = repo.getTarget(ctx.db, 'session', sessionPk);
    if (session) return session.enabled;
    const project = s.projectId ? repo.getTarget(ctx.db, 'project', s.projectId) : null;
    return project?.enabled ?? false;
  }

  function record(d: Omit<SupervisorDecisionView, 'id' | 'ts'>): SupervisorDecisionView {
    const saved = repo.insertDecision(ctx.db, { ...d, id: randomUUID(), ts: now().toISOString() });
    ctx.bus.emit({ type: 'supervisor.decided', decision: saved });
    return saved;
  }

  function escalate(
    session: Session,
    sessionPk: string,
    q: PendingQuestion,
    why: string,
    o: EscalateOpts = {},
  ): SupervisorDecisionView {
    const reason = redact(why);
    const d = record({
      sessionPk,
      projectId: session.projectId,
      question: redact(q.text),
      decision: 'escalate',
      answer: null,
      confidence: o.confidence ?? 0,
      reason,
      intent: o.intent ?? null,
      sent: false,
      costUsd: o.costUsd ?? null,
      model: o.model ?? null,
      feedback: null,
    });
    if (o.dryRun) return d;
    ctx.inbox?.upsert({
      kind: 'supervisor_escalation',
      scope: { session: sessionPk },
      sessionId: session.id,
      projectId: session.projectId,
      ticket: session.tickets[0] ?? null,
      reason: `Supervisor escalated: ${reason}`,
      payload: {
        source: session.source,
        id: session.id,
        decisionId: d.id,
        question: d.question,
        intent: d.intent,
        reason,
      },
    });
    ctx.audit.record({
      actor: 'supervisor',
      actorDetail: cfg().model,
      action: 'supervisor.escalate',
      target: sessionPk,
      params: { decisionId: d.id, reason, intent: d.intent, confidence: d.confidence },
      result: 'ok',
      error: null,
    });
    return d;
  }

  async function evaluate(sessionPk: string): Promise<SupervisorDecisionView> {
    const session = ctx.sessions.getByPk(sessionPk);
    if (!session) throw new ServiceError('not_found', 404, `session ${sessionPk} not found`);
    if (!owned(session)) {
      throw new ServiceError('not_owned', 403, 'the supervisor only answers sessions this app owns');
    }
    const ptyId = session.live.ptyId;
    const waitingFor = session.live.waitingFor;
    const dryRun = !enabledFor(sessionPk);
    const q = buildPendingQuestion(await lastAssistantText(session), waitingFor);
    if (!q) {
      return escalate(
        session,
        sessionPk,
        { text: '(no question found)', tail: '', waitingFor },
        'no pending question found',
        { dryRun },
      );
    }

    const verdict = applyRules(q, {
      rules: repo.listRules(ctx.db, session.projectId),
      deny: (text) => ctx.denyList.check(text, session.projectId),
    });
    if (verdict.denied) {
      return escalate(session, sessionPk, q, `blocked: ${verdict.denyReason ?? 'deny-list'}`, { dryRun });
    }
    const { intent, answer } = verdict;
    if (!intent || !answer)
      return escalate(session, sessionPk, q, 'no allow-listed intent matched', { dryRun });
    const answerDenied =
      ctx.denyList.check(answer, session.projectId).denied ||
      checkDenied(answer, SUPERVISOR_DENY_PATTERNS).denied;
    if (answerDenied) {
      return escalate(session, sessionPk, q, 'blocked: the canned answer matches the deny-list', {
        intent,
        dryRun,
      });
    }
    const c = cfg();
    if (inQuietHours(now(), c.quietHours)) {
      return escalate(session, sessionPk, q, 'quiet hours', { intent, dryRun });
    }

    const since = new Date(now().getTime() - HOUR_MS).toISOString();
    if (repo.countAnswered(ctx.db, since, sessionPk) >= c.maxPerSessionPerHour) {
      return escalate(session, sessionPk, q, `per-session cap reached (${c.maxPerSessionPerHour}/hour)`, {
        intent,
        dryRun,
      });
    }
    if (repo.countAnswered(ctx.db, since) >= c.maxPerHour) {
      return escalate(session, sessionPk, q, `hourly cap reached (${c.maxPerHour}/hour)`, { intent, dryRun });
    }
    const spent = repo.monthCost(ctx.db, monthStartIso(now()));
    if (spent >= c.monthlyBudgetUsd) {
      return escalate(
        session,
        sessionPk,
        q,
        `supervisor budget used ($${spent.toFixed(2)} of $${c.monthlyBudgetUsd.toFixed(2)})`,
        { intent, dryRun },
      );
    }
    const projectBudget = ctx.usage?.checkBudget({ projectId: session.projectId ?? undefined });
    if (projectBudget && !projectBudget.ok) {
      return escalate(
        session,
        sessionPk,
        q,
        `project budget exceeded (${Math.round(projectBudget.pct * 100)}%)`,
        { intent, dryRun },
      );
    }

    let result: Awaited<ReturnType<Classifier>>;
    try {
      result = await classifier({
        question: q.text,
        context: `session: ${session.name ?? session.id} · last prompt: ${session.lastPrompt ?? ''}`,
        intent,
        cannedAnswer: answer,
        model: c.model,
      });
    } catch (e) {
      return escalate(
        session,
        sessionPk,
        q,
        `classifier failed: ${e instanceof Error ? e.message : String(e)}`,
        { intent, dryRun },
      );
    }

    const { output } = result;
    const scored = {
      intent,
      confidence: output.confidence,
      costUsd: result.costUsd,
      model: result.model,
      dryRun,
    };
    if (output.decision !== 'answer' || output.confidence < cfg().confidenceThreshold) {
      return escalate(
        session,
        sessionPk,
        q,
        `model said ${output.decision} (confidence ${output.confidence.toFixed(2)}): ${output.reason}`,
        scored,
      );
    }

    const fresh = ctx.sessions.getByPk(sessionPk);
    if (!owned(fresh) || fresh.live.status !== 'waiting' || fresh.live.ptyId !== ptyId) {
      return escalate(session, sessionPk, q, 'the session changed while the model was thinking', scored);
    }

    const base = {
      sessionPk,
      projectId: session.projectId,
      question: redact(q.text),
      decision: 'answer' as const,
      answer,
      confidence: output.confidence,
      intent,
      costUsd: result.costUsd,
      model: result.model,
      feedback: null,
    };
    const modelReason = redact(output.reason);
    if (dryRun) {
      return record({
        ...base,
        sent: false,
        reason: `dry run (supervisor off for this session): ${modelReason}`,
      });
    }

    await actorScope.run({ actor: 'supervisor', actorDetail: result.model }, () =>
      ctx.pty.sendText(ptyId, answer),
    );
    const d = record({ ...base, sent: true, reason: modelReason });
    ctx.audit.record({
      actor: 'supervisor',
      actorDetail: result.model,
      action: 'supervisor.answer',
      target: sessionPk,
      params: {
        decisionId: d.id,
        intent,
        confidence: output.confidence,
        matchedBy: verdict.matchedBy,
        question: d.question.slice(-300),
        answer,
        costUsd: result.costUsd,
      },
      result: 'ok',
      error: null,
    });
    ctx.inbox?.resolve({ kind: 'waiting', scope: { session: sessionPk } });
    return d;
  }

  function addRule(r: SupervisorRuleInput, source: SupervisorRule['source'] = 'user'): SupervisorRule {
    const rule = repo.insertRule(ctx.db, { ...r, source }, now().toISOString());
    ctx.audit.record({
      actor: 'user',
      actorDetail: null,
      action: 'supervisor.rule',
      target: `supervisor-rule:${rule.id}`,
      params: { op: 'add', kind: rule.kind, pattern: rule.pattern, intent: rule.intent, source },
      result: 'ok',
      error: null,
    });
    return rule;
  }

  return {
    evaluate,
    enabledFor,
    start() {
      const off = ctx.bus.on('session.statusChanged', (e) => {
        const existing = timers.get(e.pk);
        if (existing) {
          clearTimeout(existing);
          timers.delete(e.pk);
        }
        if (e.to !== 'waiting' || !enabledFor(e.pk)) return;
        const timer = setTimeout(() => {
          timers.delete(e.pk);
          void evaluate(e.pk).catch((err: unknown) =>
            ctx.log.warn({ err, pk: e.pk }, 'supervisor evaluation failed'),
          );
        }, cfg().debounceMs);
        timer.unref?.();
        timers.set(e.pk, timer);
      });
      return () => {
        off();
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
      };
    },
    setTarget(t) {
      const saved = repo.setTarget(ctx.db, t, now().toISOString());
      ctx.audit.record({
        actor: 'user',
        actorDetail: null,
        action: 'settings.update',
        target: `supervisor:${t.targetType}:${t.targetId}`,
        params: { enabled: t.enabled },
        result: 'ok',
        error: null,
      });
      return saved;
    },
    targets: () => repo.listTargets(ctx.db),
    rules: () => repo.listAllRules(ctx.db),
    addRule: (r) => addRule(r),
    removeRule(id) {
      const removed = repo.deleteRule(ctx.db, id);
      if (removed) {
        ctx.audit.record({
          actor: 'user',
          actorDetail: null,
          action: 'supervisor.rule',
          target: `supervisor-rule:${id}`,
          params: { op: 'remove' },
          result: 'ok',
          error: null,
        });
      }
      return removed;
    },
    decisions: (q) => repo.listDecisions(ctx.db, q),
    feedbackWrong(decisionId) {
      const d = repo.getDecision(ctx.db, decisionId);
      if (!d) throw new ServiceError('not_found', 404, `supervisor decision ${decisionId} not found`);
      repo.markFeedback(ctx.db, decisionId, 'wrong');
      const rule = addRule(
        {
          projectId: d.projectId,
          kind: 'deny',
          pattern: feedbackPattern(d.question),
          intent: null,
          answer: null,
          note: `marked wrong on ${now().toISOString()}`,
        },
        'feedback',
      );
      ctx.audit.record({
        actor: 'user',
        actorDetail: null,
        action: 'supervisor.feedback',
        target: d.sessionPk,
        params: { decisionId, ruleId: rule.id },
        result: 'ok',
        error: null,
      });
      return rule;
    },
    status() {
      const c = cfg();
      const since = new Date(now().getTime() - HOUR_MS).toISOString();
      return {
        enabled: c.enabled,
        quiet: inQuietHours(now(), c.quietHours),
        model: c.model,
        confidenceThreshold: c.confidenceThreshold,
        maxPerSessionPerHour: c.maxPerSessionPerHour,
        maxPerHour: c.maxPerHour,
        quietHours: c.quietHours,
        answeredLastHour: repo.countAnswered(ctx.db, since),
        escalatedLastHour: repo.countEscalated(ctx.db, since),
        monthCostUsd: repo.monthCost(ctx.db, monthStartIso(now())),
        monthBudgetUsd: c.monthlyBudgetUsd,
      };
    },
  };
}
