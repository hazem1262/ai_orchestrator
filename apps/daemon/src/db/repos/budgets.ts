import { randomUUID } from 'node:crypto';
import type { Budget, BudgetPeriod, BudgetScopeType } from '@orc/core';
import { and, eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { budgets } from '../schema.ts';

const toBudget = (r: typeof budgets.$inferSelect): Budget => ({
  id: r.id,
  scopeType: r.scopeType,
  scopeId: r.scopeId === '' ? null : r.scopeId,
  period: r.period,
  limitUsd: r.limitUsd,
  origin: 'table',
});

export function listBudgetRows(db: OrcDb): Budget[] {
  return db.select().from(budgets).all().map(toBudget);
}

export function upsertBudget(
  db: OrcDb,
  b: { scopeType: BudgetScopeType; scopeId: string | null; period: BudgetPeriod; limitUsd: number },
  nowIso: string,
): Budget {
  const scopeId = b.scopeType === 'global' ? '' : (b.scopeId ?? '');
  db.insert(budgets)
    .values({
      id: randomUUID(),
      scopeType: b.scopeType,
      scopeId,
      period: b.period,
      limitUsd: b.limitUsd,
      createdAt: nowIso,
    })
    .onConflictDoUpdate({
      target: [budgets.scopeType, budgets.scopeId, budgets.period],
      set: { limitUsd: b.limitUsd },
    })
    .run();
  const row = db
    .select()
    .from(budgets)
    .where(
      and(eq(budgets.scopeType, b.scopeType), eq(budgets.scopeId, scopeId), eq(budgets.period, b.period)),
    )
    .get();
  if (!row) throw new Error('budget upsert failed');
  return toBudget(row);
}

export function deleteBudget(db: OrcDb, id: string): boolean {
  return db.delete(budgets).where(eq(budgets.id, id)).run().changes > 0;
}
