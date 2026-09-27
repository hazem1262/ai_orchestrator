import { randomUUID } from 'node:crypto';
import type { Goal, GoalState } from '@orc/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { goals } from '../schema.ts';

export type GoalSource = 'manual' | 'rule' | 'recap';

const toGoal = (r: typeof goals.$inferSelect): Goal => ({
  id: r.id,
  targetType: r.targetType,
  targetId: r.targetId,
  objective: r.objective,
  state: r.state,
  blockedReason: r.blockedReason,
  updatedAt: r.updatedAt,
});

export function getGoal(db: OrcDb, targetType: Goal['targetType'], targetId: string): Goal | null {
  const r = db
    .select()
    .from(goals)
    .where(and(eq(goals.targetType, targetType), eq(goals.targetId, targetId)))
    .get();
  return r ? toGoal(r) : null;
}

export function upsertGoal(
  db: OrcDb,
  g: Omit<Goal, 'id' | 'updatedAt'>,
  source: GoalSource,
  nowIso: string,
): Goal {
  const blockedReason = g.state === 'blocked' ? g.blockedReason : null;
  const row = {
    targetType: g.targetType,
    targetId: g.targetId,
    objective: g.objective,
    state: g.state,
    blockedReason,
    source,
    updatedAt: nowIso,
  };
  db.insert(goals)
    .values({ id: randomUUID(), ...row })
    .onConflictDoUpdate({
      target: [goals.targetType, goals.targetId],
      set: { objective: g.objective, state: g.state, blockedReason, source, updatedAt: nowIso },
    })
    .run();
  const out = getGoal(db, g.targetType, g.targetId);
  if (!out) throw new Error('goal upsert failed');
  return out;
}

export function listGoals(db: OrcDb, states?: GoalState[]): Goal[] {
  return db
    .select()
    .from(goals)
    .where(states && states.length > 0 ? inArray(goals.state, states) : undefined)
    .orderBy(desc(goals.updatedAt))
    .all()
    .map(toGoal);
}

export function goalSource(db: OrcDb, id: string): GoalSource | null {
  return db.select({ s: goals.source }).from(goals).where(eq(goals.id, id)).get()?.s ?? null;
}
