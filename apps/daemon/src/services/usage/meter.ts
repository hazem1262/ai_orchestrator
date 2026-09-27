import {
  type BudgetCheck,
  type BudgetStatus,
  type ConcurrencyStatus,
  type ContextFillInfo,
  computeUsageSnapshot,
  contextFill,
  type InboxItem,
  mapOfficialQuota,
  type OfficialQuotaSample,
  quotaTokens,
  type UsageSnapshot,
  WEEK_MS,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { type InboxEngine, type InboxKey, type InboxScope, inboxDedupeKey } from '../../inbox/engine.ts';
import {
  allBudgets,
  budgetAlertLevel,
  budgetInboxKey,
  checkBudgetScope,
  evaluateBudgets,
  raiseBudgetAlerts,
} from './budgets.ts';
import type { UsageLedger } from './ledger.ts';

export type { UsageSnapshot } from '@orc/core';

export interface UsageMeter {
  snapshot(): UsageSnapshot;
  checkBudget(scope: { projectId?: string; ticket?: string }): BudgetCheck;
  refresh(now?: Date): UsageSnapshot;
  ingestOfficial(raw: unknown): OfficialQuotaSample | null;
  budgets(now?: Date): BudgetStatus[];
  contextFill(sessionPk: string): ContextFillInfo | null;
  concurrency(): ConcurrencyStatus[];
  start(): void;
  stop(): void;
}

type MeterInbox = Pick<InboxEngine, 'upsert' | 'resolve'> & Partial<Pick<InboxEngine, 'list'>>;

const PROJECTION_WARN_MS = 60 * 60_000;
const BLOCK_LOOKBACK_MS = 5 * 3_600_000;
const hhmm = (iso: string) => iso.slice(11, 16);

export function quotaAlertKeys(s: UsageSnapshot, warnPct: number): Array<{ key: InboxKey; reason: string }> {
  const out: Array<{ key: InboxKey; reason: string }> = [];
  const label = s.source === 'estimate' ? ' (estimated)' : '';
  const pct = s.block.pctOfLimit;
  const projected = s.projectedBlockExhaustionAt ? Date.parse(s.projectedBlockExhaustionAt) : null;
  const soon = projected !== null && projected - Date.parse(s.generatedAt) <= PROJECTION_WARN_MS;
  if (s.block.active && ((pct !== null && pct >= warnPct) || soon)) {
    const pctText = pct !== null ? `${Math.round(pct * 100)}%` : 'high burn';
    const proj = s.projectedBlockExhaustionAt ? `, runs out ~${hhmm(s.projectedBlockExhaustionAt)} UTC` : '';
    out.push({
      key: { kind: 'budget', scope: { domain: 'quota', id: 'block' }, facet: s.block.start },
      reason: `5h block at ${pctText}${label}${proj} — resets ${hhmm(s.block.end)} UTC`,
    });
  }
  if (s.week.pctOfLimit !== null && s.week.pctOfLimit >= warnPct) {
    const weekKey = new Date(Date.parse(s.generatedAt) - WEEK_MS).toISOString().slice(0, 10);
    out.push({
      key: { kind: 'budget', scope: { domain: 'quota', id: 'week' }, facet: weekKey },
      reason: `7-day usage at ${Math.round(s.week.pctOfLimit * 100)}%${label}`,
    });
  }
  return out;
}

const sameSnapshot = (a: UsageSnapshot | null, b: UsageSnapshot) =>
  a !== null && JSON.stringify({ ...a, generatedAt: '' }) === JSON.stringify({ ...b, generatedAt: '' });

/** The inbox identity a budget or quota alert stored in its payload, or null for any other item. */
function storedKey(item: InboxItem): InboxKey | null {
  const { scope, facet } = item.payload;
  if (typeof scope !== 'object' || scope === null || typeof facet !== 'string') return null;
  return { kind: item.kind, scope: scope as InboxScope, facet };
}

export function createUsageMeter(
  ctx: DaemonContext,
  deps: { ledger: UsageLedger; inbox?: MeterInbox | null; now?: () => Date; tickMs?: number },
): UsageMeter {
  const now = deps.now ?? (() => new Date());
  const inbox = (): MeterInbox | null => (deps.inbox === undefined ? (ctx.inbox ?? null) : deps.inbox);
  let last: UsageSnapshot | null = null;
  let official: OfficialQuotaSample | null = null;
  let budgetKeys = new Set<string>();
  let quotaKeys = new Map<string, InboxKey>();
  let reconciled = false;
  let timer: NodeJS.Timeout | null = null;
  let debounce: NodeJS.Timeout | null = null;
  const unsubs: Array<() => void> = [];

  function budgets(at: Date = now()): BudgetStatus[] {
    return evaluateBudgets(allBudgets(ctx.db, ctx.config()), (q) => deps.ledger.sumCost(q), at);
  }

  function compute(at: Date): UsageSnapshot {
    const lim = ctx.config().limits;
    const from = new Date(at.getTime() - WEEK_MS - BLOCK_LOOKBACK_MS).toISOString();
    const entries = deps.ledger.entries({ from, to: at.toISOString() }).map((e) => ({
      ts: Date.parse(e.ts),
      tokens: quotaTokens(e),
      costUsd: e.allocCostUsd,
    }));
    return computeUsageSnapshot({
      entries,
      now: at.getTime(),
      limits: { blockTokenLimit: lim.blockTokenLimit, weekTokenLimit: lim.weekTokenLimit },
      official: lim.quotaSource === 'official' ? official : null,
    });
  }

  /**
   * The in-memory key sets start empty in a new process, so an alert raised before a restart would
   * stay open forever once its period rolled over. The first pass resolves every active `budget`
   * item that is no longer wanted, by the identity it stored in its payload.
   */
  function reconcile(box: MeterInbox, wanted: ReadonlySet<string>): void {
    if (reconciled || !box.list) return;
    reconciled = true;
    for (const item of box.list({ state: ['open', 'snoozed'], kind: ['budget'] })) {
      const key = storedKey(item);
      if (key && !wanted.has(inboxDedupeKey(key))) box.resolve(key);
    }
  }

  function alerts(s: UsageSnapshot, at: Date): void {
    const box = inbox();
    if (!box) return;
    const warnPct = ctx.config().limits.warnPct;
    const statuses = budgets(at);
    budgetKeys = raiseBudgetAlerts(box, statuses, warnPct, budgetKeys);
    const next = new Map<string, InboxKey>();
    for (const a of quotaAlertKeys(s, warnPct)) {
      const dedupe = inboxDedupeKey(a.key);
      next.set(dedupe, a.key);
      if (!quotaKeys.has(dedupe)) {
        box.upsert({
          ...a.key,
          reason: a.reason,
          payload: { quota: true, source: s.source, scope: a.key.scope, facet: a.key.facet },
        });
      }
    }
    for (const [dedupe, key] of quotaKeys) if (!next.has(dedupe)) box.resolve(key);
    quotaKeys = next;
    if (!reconciled) {
      const wanted = new Set(next.keys());
      for (const st of statuses) {
        const level = budgetAlertLevel(st, warnPct);
        if (level !== null) wanted.add(inboxDedupeKey(budgetInboxKey(st, level)));
      }
      reconcile(box, wanted);
    }
  }

  function refresh(at: Date = now()): UsageSnapshot {
    const s = compute(at);
    const changed = !sameSnapshot(last, s);
    last = s;
    if (changed) ctx.bus.emit({ type: 'usage.updated', snapshot: s });
    alerts(s, at);
    return s;
  }

  function fillFor(pk: string): ContextFillInfo | null {
    const latest = deps.ledger.latestMainUsage(pk);
    if (!latest) return null;
    const lim = ctx.config().limits;
    const f = contextFill(latest.usage, latest.model, lim.contextWindows, lim.defaultContextWindow);
    if (!f) return null;
    return { sessionPk: pk, model: latest.model, ...f, warn: f.fill >= lim.contextWarnFill };
  }

  return {
    snapshot: () => last ?? refresh(),
    checkBudget: (scope) => checkBudgetScope(budgets(), scope),
    refresh,
    ingestOfficial(raw) {
      const lim = ctx.config().limits;
      if (lim.quotaSource !== 'official') return null;
      const sample = mapOfficialQuota(raw, lim.officialFieldPaths, now().toISOString());
      if (sample) {
        official = sample;
        refresh();
      }
      return sample;
    },
    budgets,
    contextFill: fillFor,
    concurrency: () =>
      ctx.config().projects.map((p) => ({
        projectId: p.id,
        owned: ctx.launcher?.ownedCount(p.id) ?? 0,
        max: p.maxConcurrentOwned,
      })),
    start() {
      if (timer) return;
      refresh();
      timer = setInterval(() => refresh(), deps.tickMs ?? 60_000);
      timer.unref();
      unsubs.push(
        ctx.bus.on('session.updated', () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => refresh(), 5000);
          debounce.unref();
        }),
        ctx.bus.on('config.changed', () => refresh()),
      );
    },
    stop() {
      if (timer) clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      timer = null;
      debounce = null;
      for (const u of unsubs.splice(0)) u();
    },
  };
}
