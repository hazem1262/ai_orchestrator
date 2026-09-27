import { estimateCostUsd, extractLedgerFacts, type Session, type Usage } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import {
  countRealEntries,
  deleteSynthetic,
  getCursor,
  insertToolUses,
  insertUsageEntries,
  type LedgerEntry,
  type LedgerQuery,
  type LedgerTool,
  latestMainEntry,
  listEntries,
  listTools,
  SYNTHETIC_MESSAGE_ID,
  setCursor,
  setToolDuration,
  sumAllocCost,
  sumEstCost,
  updateSessionAttribution,
  upsertSynthetic,
} from '../../db/repos/usage-ledger.ts';
import { listAllSessions } from '../session-pages.ts';
import { sessionPk } from '../sessions.ts';

export type { LedgerEntry, LedgerQuery, LedgerTool };

export interface UsageLedger {
  syncSession(sessionPk: string): Promise<{ added: number }>;
  backfill(sinceIso: string): Promise<{ sessions: number }>;
  entries(q: LedgerQuery): LedgerEntry[];
  tools(q: Omit<LedgerQuery, 'ticket'>): LedgerTool[];
  sumCost(q: LedgerQuery): number;
  latestMainUsage(sessionPk: string): { model: string; usage: Usage } | null;
  start(): void;
  stop(): void;
}

const PAGE = 500;

export function createUsageLedger(
  ctx: DaemonContext,
  opts: { debounceMs?: number; sweepMs?: number; backfillDays?: number; now?: () => Date } = {},
): UsageLedger {
  const debounceMs = opts.debounceMs ?? 2000;
  const sweepMs = opts.sweepMs ?? 5 * 60_000;
  const backfillDays = opts.backfillDays ?? 35;
  const now = opts.now ?? (() => new Date());
  const pending = new Map<string, NodeJS.Timeout>();
  const unsubs: Array<() => void> = [];
  let sweep: NodeJS.Timeout | null = null;
  const inflight = new Map<string, Promise<{ added: number }>>();

  const cost = (model: string, u: Usage) =>
    u.costUsd ?? estimateCostUsd(model, u, ctx.config().limits.pricing) ?? 0;

  function baseRow(
    s: Session,
  ): Pick<LedgerEntry, 'sessionPk' | 'source' | 'projectId' | 'tickets' | 'authoritative'> {
    return {
      sessionPk: sessionPk(s.source, s.id),
      source: s.source,
      projectId: s.projectId,
      tickets: s.tickets,
      authoritative: false,
    };
  }

  async function doSync(pk: string): Promise<{ added: number }> {
    const s = ctx.sessions.getByPk(pk);
    if (!s) return { added: 0 };
    const agentIds: Array<string | null> = [null, ...ctx.sessions.agents(s.source, s.id).map((a) => a.id)];
    let added = 0;
    for (const agentId of agentIds) {
      const agentKey = agentId ?? '';
      let cur = getCursor(ctx.db, pk, agentKey);
      for (;;) {
        const page = ctx.sessions.events(s.source, s.id, { agentId, afterSeq: cur.afterSeq, limit: PAGE });
        const last = page.items.at(-1);
        if (!last) break;
        const facts = extractLedgerFacts(page.items, agentKey, cur.lastTs);
        added += insertUsageEntries(
          ctx.db,
          facts.usage.map((f) => ({
            ...baseRow(s),
            agentKey,
            messageId: f.messageId,
            ts: f.ts,
            model: f.model,
            input: f.usage.input,
            output: f.usage.output,
            cacheRead: f.usage.cacheRead,
            cacheWrite: f.usage.cacheWrite,
            estCostUsd: cost(f.model, f.usage),
            allocCostUsd: 0,
            latencyMs: f.latencyMs,
          })),
        );
        insertToolUses(
          ctx.db,
          facts.tools.map((t) => ({
            sessionPk: pk,
            agentKey,
            factKey: t.factKey,
            ts: t.ts,
            kind: t.kind,
            name: t.name,
            toolUseId: t.toolUseId,
            projectId: s.projectId,
            durationMs: null,
          })),
        );
        for (const r of facts.toolResults) setToolDuration(ctx.db, pk, r.toolUseId, r.ts);
        cur = { afterSeq: last.seq, lastTs: facts.lastTs ?? cur.lastTs };
        setCursor(ctx.db, pk, agentKey, cur);
        if (page.nextSeq === null) break;
      }
    }

    const real = countRealEntries(ctx.db, pk);
    const tokens = s.usage.input + s.usage.output + s.usage.cacheRead + s.usage.cacheWrite;
    if (real > 0) {
      deleteSynthetic(ctx.db, pk);
    } else if (tokens > 0) {
      const model = s.models[0] ?? 'unknown';
      upsertSynthetic(ctx.db, {
        ...baseRow(s),
        agentKey: '',
        messageId: SYNTHETIC_MESSAGE_ID,
        ts: s.lastActivityAt,
        model,
        input: s.usage.input,
        output: s.usage.output,
        cacheRead: s.usage.cacheRead,
        cacheWrite: s.usage.cacheWrite,
        estCostUsd: cost(model, s.usage),
        allocCostUsd: 0,
        latencyMs: null,
      });
    }

    const est = sumEstCost(ctx.db, pk);
    const authoritative = s.usage.costUsd !== null && est > 0;
    updateSessionAttribution(ctx.db, pk, {
      projectId: s.projectId,
      tickets: s.tickets,
      factor: authoritative ? (s.usage.costUsd as number) / est : 1,
      authoritative,
    });
    return { added };
  }

  function syncSession(pk: string): Promise<{ added: number }> {
    const running = inflight.get(pk);
    if (running) return running.then(() => doSync(pk));
    const p = doSync(pk).finally(() => inflight.delete(pk));
    inflight.set(pk, p);
    return p;
  }

  async function backfill(sinceIso: string): Promise<{ sessions: number }> {
    const items = listAllSessions(ctx, { from: sinceIso });
    for (const it of items) await syncSession(it.pk);
    return { sessions: items.length };
  }

  function schedule(pk: string): void {
    const t = pending.get(pk);
    if (t) clearTimeout(t);
    pending.set(
      pk,
      setTimeout(() => {
        pending.delete(pk);
        syncSession(pk).catch((err: unknown) => ctx.log.warn({ err, pk }, 'ledger sync failed'));
      }, debounceMs),
    );
  }

  return {
    syncSession,
    backfill,
    entries: (q) => listEntries(ctx.db, q),
    tools: (q) => listTools(ctx.db, q),
    sumCost: (q) => sumAllocCost(ctx.db, q),
    latestMainUsage(pk) {
      const e = latestMainEntry(ctx.db, pk);
      return e
        ? {
            model: e.model,
            usage: {
              input: e.input,
              output: e.output,
              cacheRead: e.cacheRead,
              cacheWrite: e.cacheWrite,
              costUsd: null,
            },
          }
        : null;
    },
    start() {
      unsubs.push(ctx.bus.on('session.updated', (e) => schedule(sessionPk(e.session.source, e.session.id))));
      const since = new Date(now().getTime() - backfillDays * 86_400_000).toISOString();
      backfill(since).catch((err: unknown) => ctx.log.warn({ err }, 'ledger backfill failed'));
      sweep = setInterval(() => {
        const dayAgo = new Date(now().getTime() - 86_400_000).toISOString();
        backfill(dayAgo).catch((err: unknown) => ctx.log.warn({ err }, 'ledger sweep failed'));
      }, sweepMs);
    },
    stop() {
      for (const u of unsubs.splice(0)) u();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      if (sweep) clearInterval(sweep);
      sweep = null;
    },
  };
}
