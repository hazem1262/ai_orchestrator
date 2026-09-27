import type { OrcConfig } from '@orc/api-contract';
import type { Budget, BudgetCheck, BudgetPeriod, BudgetStatus } from '@orc/core';
import type { OrcDb } from '../../db/client.ts';
import { listBudgetRows } from '../../db/repos/budgets.ts';
import type { InboxEngine, InboxKey, InboxScope } from '../../inbox/engine.ts';

export type SumCost = (q: { from: string; to: string; projectId?: string; ticket?: string }) => number;

export function periodStart(period: BudgetPeriod, now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'weekly') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (period === 'monthly') d.setDate(1);
  return d;
}

const PERIOD_FIELDS: Array<[BudgetPeriod, 'dailyUsd' | 'weeklyUsd' | 'monthlyUsd']> = [
  ['daily', 'dailyUsd'],
  ['weekly', 'weeklyUsd'],
  ['monthly', 'monthlyUsd'],
];

export function configBudgets(cfg: OrcConfig): Budget[] {
  const out: Budget[] = [];
  for (const p of cfg.projects) {
    for (const [period, field] of PERIOD_FIELDS) {
      const limit = p.budgets[field];
      if (limit !== undefined && limit > 0) {
        out.push({
          id: `config:${p.id}:${period}`,
          scopeType: 'project',
          scopeId: p.id,
          period,
          limitUsd: limit,
          origin: 'config',
        });
      }
    }
  }
  return out;
}

const scopeKey = (b: Budget) => `${b.scopeType}:${b.scopeId ?? ''}:${b.period}`;

export function allBudgets(db: OrcDb, cfg: OrcConfig): Budget[] {
  const table = listBudgetRows(db);
  const taken = new Set(table.map(scopeKey));
  return [...configBudgets(cfg).filter((b) => !taken.has(scopeKey(b))), ...table];
}

export function evaluateBudgets(budgets: Budget[], sumCost: SumCost, now: Date): BudgetStatus[] {
  const to = now.toISOString();
  return budgets.map((budget) => {
    const from = periodStart(budget.period, now).toISOString();
    const q: Parameters<SumCost>[0] = { from, to };
    if (budget.scopeType === 'project' && budget.scopeId !== null) q.projectId = budget.scopeId;
    if (budget.scopeType === 'ticket' && budget.scopeId !== null) q.ticket = budget.scopeId;
    const spentUsd = sumCost(q);
    return { budget, spentUsd, pct: budget.limitUsd > 0 ? spentUsd / budget.limitUsd : 0, periodStart: from };
  });
}

export function checkBudgetScope(
  statuses: BudgetStatus[],
  scope: { projectId?: string; ticket?: string },
): BudgetCheck {
  const relevant = statuses.filter(
    (s) =>
      s.budget.scopeType === 'global' ||
      (s.budget.scopeType === 'project' &&
        scope.projectId !== undefined &&
        s.budget.scopeId === scope.projectId) ||
      (s.budget.scopeType === 'ticket' && scope.ticket !== undefined && s.budget.scopeId === scope.ticket),
  );
  let worst: BudgetStatus | null = null;
  for (const s of relevant) if (worst === null || s.pct > worst.pct) worst = s;
  if (worst === null) return { ok: true, pct: 0, limitUsd: null };
  return { ok: worst.pct < 1, pct: worst.pct, limitUsd: worst.budget.limitUsd };
}

export function budgetAlertKey(s: BudgetStatus, level: 'warn' | 'over'): string {
  const b = s.budget;
  return `budget:${b.scopeType}:${b.scopeId ?? 'all'}:${b.period}:${s.periodStart.slice(0, 10)}:${level}`;
}

export function budgetAlertLevel(s: BudgetStatus, warnPct: number): 'warn' | 'over' | null {
  return s.pct >= 1 ? 'over' : s.pct >= warnPct ? 'warn' : null;
}

export function budgetInboxKey(s: BudgetStatus, level: 'warn' | 'over'): InboxKey {
  const b = s.budget;
  let scope: InboxScope = { global: true };
  if (b.scopeType === 'project' && b.scopeId !== null) scope = { project: b.scopeId };
  if (b.scopeType === 'ticket' && b.scopeId !== null) scope = { ticket: b.scopeId };
  return { kind: 'budget', scope, facet: `${b.period}:${s.periodStart.slice(0, 10)}:${level}` };
}

/**
 * Alert key -> inbox identity for every alert raised so far, so a stale key can be resolved without
 * parsing it back apart (scope ids may contain `:`). Entries are dropped once resolved.
 */
const raisedInboxKeys = new Map<string, InboxKey>();

const usd = (n: number) => `$${n.toFixed(2)}`;

export function raiseBudgetAlerts(
  inbox: Pick<InboxEngine, 'upsert' | 'resolve'>,
  statuses: BudgetStatus[],
  warnPct: number,
  previous: ReadonlySet<string>,
): Set<string> {
  const raised = new Set<string>();
  for (const s of statuses) {
    const level = budgetAlertLevel(s, warnPct);
    if (level === null) continue;
    const key = budgetAlertKey(s, level);
    raised.add(key);
    if (previous.has(key)) continue;
    const inboxKey = budgetInboxKey(s, level);
    raisedInboxKeys.set(key, inboxKey);
    const b = s.budget;
    const label = b.scopeType === 'global' ? 'all projects' : `${b.scopeType} ${b.scopeId}`;
    inbox.upsert({
      ...inboxKey,
      projectId: b.scopeType === 'project' ? b.scopeId : null,
      ticket: b.scopeType === 'ticket' ? b.scopeId : null,
      reason:
        level === 'over'
          ? `Over ${b.period} budget for ${label}: ${usd(s.spentUsd)} of ${usd(b.limitUsd)}`
          : `${Math.round(s.pct * 100)}% of ${b.period} budget for ${label}: ${usd(s.spentUsd)} of ${usd(b.limitUsd)}`,
      payload: {
        budgetId: b.id,
        pct: s.pct,
        spentUsd: s.spentUsd,
        limitUsd: b.limitUsd,
        level,
        // The inbox identity, so a later process can resolve this item without the in-memory map.
        scope: inboxKey.scope,
        facet: inboxKey.facet,
      },
    });
  }
  for (const key of previous) {
    if (raised.has(key)) continue;
    const inboxKey = raisedInboxKeys.get(key);
    if (inboxKey === undefined) continue;
    inbox.resolve(inboxKey);
    raisedInboxKeys.delete(key);
  }
  return raised;
}
