import { randomUUID } from 'node:crypto';
import type {
  SupervisorDecisionView,
  SupervisorIntent,
  SupervisorRule,
  SupervisorRuleInput,
  SupervisorTarget,
} from '@orc/api-contract';
import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { supervisorDecisions, supervisorRules, supervisorTargets } from '../schema.ts';

type RuleRow = typeof supervisorRules.$inferSelect;
type DecisionRow = typeof supervisorDecisions.$inferSelect;
type TargetRow = typeof supervisorTargets.$inferSelect;

const toRule = (r: RuleRow): SupervisorRule => ({
  id: r.id,
  projectId: r.projectId,
  kind: r.kind as SupervisorRule['kind'],
  pattern: r.pattern,
  intent: (r.intent as SupervisorIntent | null) ?? null,
  answer: r.answer,
  source: r.source as SupervisorRule['source'],
  enabled: r.enabled,
  note: r.note,
  createdAt: r.createdAt,
});

const toDecision = (r: DecisionRow): SupervisorDecisionView => ({
  id: r.id,
  sessionPk: r.sessionPk,
  projectId: r.projectId,
  question: r.question,
  decision: r.decision as SupervisorDecisionView['decision'],
  answer: r.answer,
  confidence: r.confidence,
  reason: r.reason,
  intent: (r.intent as SupervisorIntent | null) ?? null,
  sent: r.sent,
  costUsd: r.costUsd,
  model: r.model,
  feedback: r.feedback === 'wrong' ? 'wrong' : null,
  ts: r.ts,
});

const toTarget = (r: TargetRow): SupervisorTarget => ({
  targetType: r.targetType as SupervisorTarget['targetType'],
  targetId: r.targetId,
  enabled: r.enabled,
});

export function listRules(db: OrcDb, projectId?: string | null): SupervisorRule[] {
  const scope = projectId
    ? or(isNull(supervisorRules.projectId), eq(supervisorRules.projectId, projectId))
    : isNull(supervisorRules.projectId);
  return db
    .select()
    .from(supervisorRules)
    .where(and(eq(supervisorRules.enabled, true), scope))
    .orderBy(supervisorRules.createdAt)
    .all()
    .map(toRule);
}

export function listAllRules(db: OrcDb): SupervisorRule[] {
  return db.select().from(supervisorRules).orderBy(supervisorRules.createdAt).all().map(toRule);
}

export function insertRule(
  db: OrcDb,
  r: SupervisorRuleInput & { source: SupervisorRule['source'] },
  now: string,
): SupervisorRule {
  const row = db
    .insert(supervisorRules)
    .values({
      id: randomUUID(),
      projectId: r.projectId,
      kind: r.kind,
      pattern: r.pattern,
      intent: r.intent,
      answer: r.answer,
      source: r.source,
      enabled: true,
      note: r.note,
      createdAt: now,
    })
    .returning()
    .all()[0];
  if (!row) throw new Error('supervisor rule was not saved');
  return toRule(row);
}

export function deleteRule(db: OrcDb, id: string): boolean {
  return db.delete(supervisorRules).where(eq(supervisorRules.id, id)).run().changes > 0;
}

export function insertDecision(db: OrcDb, d: SupervisorDecisionView): SupervisorDecisionView {
  db.insert(supervisorDecisions)
    .values({ ...d })
    .run();
  const saved = getDecision(db, d.id);
  if (!saved) throw new Error(`supervisor decision ${d.id} was not saved`);
  return saved;
}

export function getDecision(db: OrcDb, id: string): SupervisorDecisionView | null {
  const row = db.select().from(supervisorDecisions).where(eq(supervisorDecisions.id, id)).get();
  return row ? toDecision(row) : null;
}

export function listDecisions(
  db: OrcDb,
  q: { sessionPk?: string; limit?: number },
): SupervisorDecisionView[] {
  const base = db.select().from(supervisorDecisions);
  const rows = q.sessionPk
    ? base
        .where(eq(supervisorDecisions.sessionPk, q.sessionPk))
        .orderBy(desc(supervisorDecisions.ts))
        .limit(q.limit ?? 100)
        .all()
    : base
        .orderBy(desc(supervisorDecisions.ts))
        .limit(q.limit ?? 100)
        .all();
  return rows.map(toDecision);
}

export function markFeedback(db: OrcDb, id: string, feedback: 'wrong'): SupervisorDecisionView {
  db.update(supervisorDecisions).set({ feedback }).where(eq(supervisorDecisions.id, id)).run();
  const d = getDecision(db, id);
  if (!d) throw new Error(`supervisor decision ${id} not found`);
  return d;
}

export function countAnswered(db: OrcDb, sinceIso: string, sessionPk?: string): number {
  const where = sessionPk
    ? and(
        eq(supervisorDecisions.sent, true),
        gte(supervisorDecisions.ts, sinceIso),
        eq(supervisorDecisions.sessionPk, sessionPk),
      )
    : and(eq(supervisorDecisions.sent, true), gte(supervisorDecisions.ts, sinceIso));
  return Number(db.select({ n: sql<number>`count(*)` }).from(supervisorDecisions).where(where).get()?.n ?? 0);
}

export function countEscalated(db: OrcDb, sinceIso: string): number {
  return Number(
    db
      .select({ n: sql<number>`count(*)` })
      .from(supervisorDecisions)
      .where(and(eq(supervisorDecisions.decision, 'escalate'), gte(supervisorDecisions.ts, sinceIso)))
      .get()?.n ?? 0,
  );
}

export function monthCost(db: OrcDb, sinceIso: string): number {
  return Number(
    db
      .select({ total: sql<number>`coalesce(sum(${supervisorDecisions.costUsd}), 0)` })
      .from(supervisorDecisions)
      .where(gte(supervisorDecisions.ts, sinceIso))
      .get()?.total ?? 0,
  );
}

export function getTarget(
  db: OrcDb,
  targetType: SupervisorTarget['targetType'],
  targetId: string,
): SupervisorTarget | null {
  const row = db
    .select()
    .from(supervisorTargets)
    .where(and(eq(supervisorTargets.targetType, targetType), eq(supervisorTargets.targetId, targetId)))
    .get();
  return row ? toTarget(row) : null;
}

export function setTarget(db: OrcDb, t: SupervisorTarget, now: string): SupervisorTarget {
  db.insert(supervisorTargets)
    .values({ targetType: t.targetType, targetId: t.targetId, enabled: t.enabled, updatedAt: now })
    .onConflictDoUpdate({
      target: [supervisorTargets.targetType, supervisorTargets.targetId],
      set: { enabled: t.enabled, updatedAt: now },
    })
    .run();
  const saved = getTarget(db, t.targetType, t.targetId);
  if (!saved) throw new Error('supervisor target was not saved');
  return saved;
}

export function listTargets(db: OrcDb): SupervisorTarget[] {
  return db
    .select()
    .from(supervisorTargets)
    .orderBy(supervisorTargets.targetType, supervisorTargets.targetId)
    .all()
    .map(toTarget);
}
