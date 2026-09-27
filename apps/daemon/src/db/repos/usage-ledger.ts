import type { ToolKind } from '@orc/core';
import { and, asc, desc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { ledgerCursors, toolUses, usageEntries } from '../schema.ts';

export interface LedgerEntry {
  sessionPk: string;
  agentKey: string;
  messageId: string;
  ts: string;
  source: string;
  projectId: string | null;
  tickets: string[];
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  estCostUsd: number;
  allocCostUsd: number;
  authoritative: boolean;
  latencyMs: number | null;
}
export interface LedgerTool {
  sessionPk: string;
  agentKey: string;
  factKey: string;
  ts: string;
  kind: ToolKind;
  name: string;
  toolUseId: string | null;
  projectId: string | null;
  durationMs: number | null;
}
export interface LedgerQuery {
  from: string;
  to: string;
  projectId?: string;
  ticket?: string;
}

export const SYNTHETIC_MESSAGE_ID = 'session-total';

type EntryRow = typeof usageEntries.$inferSelect;

function toEntry(r: EntryRow): LedgerEntry {
  let tickets: string[] = [];
  try {
    const v: unknown = JSON.parse(r.ticketsJson);
    if (Array.isArray(v)) tickets = v.filter((x): x is string => typeof x === 'string');
  } catch {
    tickets = [];
  }
  const { ticketsJson: _t, ...rest } = r;
  return { ...rest, tickets };
}

const toRow = (e: LedgerEntry) => {
  const { tickets, ...rest } = e;
  return { ...rest, ticketsJson: JSON.stringify(tickets) };
};

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export function insertUsageEntries(db: OrcDb, rows: LedgerEntry[]): number {
  let n = 0;
  for (const part of chunks(rows, 400)) {
    n += db.insert(usageEntries).values(part.map(toRow)).onConflictDoNothing().run().changes;
  }
  return n;
}

export function insertToolUses(db: OrcDb, rows: LedgerTool[]): number {
  let n = 0;
  for (const part of chunks(rows, 500))
    n += db.insert(toolUses).values(part).onConflictDoNothing().run().changes;
  return n;
}

export function setToolDuration(db: OrcDb, sessionPk: string, toolUseId: string, resultTs: string): void {
  const call = db
    .select({ ts: toolUses.ts, agentKey: toolUses.agentKey, factKey: toolUses.factKey })
    .from(toolUses)
    .where(and(eq(toolUses.sessionPk, sessionPk), eq(toolUses.toolUseId, toolUseId)))
    .get();
  if (!call) return;
  const ms = Date.parse(resultTs) - Date.parse(call.ts);
  if (!Number.isFinite(ms) || ms < 0) return;
  db.update(toolUses)
    .set({ durationMs: ms })
    .where(
      and(
        eq(toolUses.sessionPk, sessionPk),
        eq(toolUses.agentKey, call.agentKey),
        eq(toolUses.factKey, call.factKey),
      ),
    )
    .run();
}

export function getCursor(
  db: OrcDb,
  sessionPk: string,
  agentKey: string,
): { afterSeq: number; lastTs: string | null } {
  const r = db
    .select()
    .from(ledgerCursors)
    .where(and(eq(ledgerCursors.sessionPk, sessionPk), eq(ledgerCursors.agentKey, agentKey)))
    .get();
  return r ? { afterSeq: r.afterSeq, lastTs: r.lastTs } : { afterSeq: 0, lastTs: null };
}

export function setCursor(
  db: OrcDb,
  sessionPk: string,
  agentKey: string,
  c: { afterSeq: number; lastTs: string | null },
): void {
  db.insert(ledgerCursors)
    .values({ sessionPk, agentKey, afterSeq: c.afterSeq, lastTs: c.lastTs })
    .onConflictDoUpdate({
      target: [ledgerCursors.sessionPk, ledgerCursors.agentKey],
      set: { afterSeq: c.afterSeq, lastTs: c.lastTs },
    })
    .run();
}

export function countRealEntries(db: OrcDb, sessionPk: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(usageEntries)
      .where(and(eq(usageEntries.sessionPk, sessionPk), ne(usageEntries.messageId, SYNTHETIC_MESSAGE_ID)))
      .get()?.n ?? 0
  );
}

export function deleteSynthetic(db: OrcDb, sessionPk: string): void {
  db.delete(usageEntries)
    .where(and(eq(usageEntries.sessionPk, sessionPk), eq(usageEntries.messageId, SYNTHETIC_MESSAGE_ID)))
    .run();
}

export function upsertSynthetic(db: OrcDb, row: LedgerEntry): void {
  const r = toRow(row);
  db.insert(usageEntries)
    .values(r)
    .onConflictDoUpdate({
      target: [usageEntries.sessionPk, usageEntries.agentKey, usageEntries.messageId],
      set: {
        ts: r.ts,
        model: r.model,
        input: r.input,
        output: r.output,
        cacheRead: r.cacheRead,
        cacheWrite: r.cacheWrite,
        estCostUsd: r.estCostUsd,
      },
    })
    .run();
}

export function sumEstCost(db: OrcDb, sessionPk: string): number {
  return (
    db
      .select({ s: sql<number>`coalesce(sum(${usageEntries.estCostUsd}), 0)` })
      .from(usageEntries)
      .where(eq(usageEntries.sessionPk, sessionPk))
      .get()?.s ?? 0
  );
}

export function updateSessionAttribution(
  db: OrcDb,
  sessionPk: string,
  a: { projectId: string | null; tickets: string[]; factor: number; authoritative: boolean },
): void {
  db.update(usageEntries)
    .set({
      projectId: a.projectId,
      ticketsJson: JSON.stringify(a.tickets),
      allocCostUsd: sql`${usageEntries.estCostUsd} * ${a.factor}`,
      authoritative: a.authoritative,
    })
    .where(eq(usageEntries.sessionPk, sessionPk))
    .run();
  db.update(toolUses).set({ projectId: a.projectId }).where(eq(toolUses.sessionPk, sessionPk)).run();
}

function entryWhere(q: LedgerQuery) {
  return and(
    gte(usageEntries.ts, q.from),
    lte(usageEntries.ts, q.to),
    q.projectId === undefined ? undefined : eq(usageEntries.projectId, q.projectId),
    q.ticket === undefined ? undefined : sql`${usageEntries.ticketsJson} like ${`%"${q.ticket}"%`}`,
  );
}

export function listEntries(db: OrcDb, q: LedgerQuery): LedgerEntry[] {
  return db.select().from(usageEntries).where(entryWhere(q)).orderBy(asc(usageEntries.ts)).all().map(toEntry);
}

export function listTools(db: OrcDb, q: Omit<LedgerQuery, 'ticket'>): LedgerTool[] {
  return db
    .select()
    .from(toolUses)
    .where(
      and(
        gte(toolUses.ts, q.from),
        lte(toolUses.ts, q.to),
        q.projectId === undefined ? undefined : eq(toolUses.projectId, q.projectId),
      ),
    )
    .orderBy(asc(toolUses.ts))
    .all();
}

export function sumAllocCost(db: OrcDb, q: LedgerQuery): number {
  return (
    db
      .select({ s: sql<number>`coalesce(sum(${usageEntries.allocCostUsd}), 0)` })
      .from(usageEntries)
      .where(entryWhere(q))
      .get()?.s ?? 0
  );
}

export function latestMainEntry(db: OrcDb, sessionPk: string): LedgerEntry | null {
  const r = db
    .select()
    .from(usageEntries)
    .where(
      and(
        eq(usageEntries.sessionPk, sessionPk),
        eq(usageEntries.agentKey, ''),
        ne(usageEntries.messageId, SYNTHETIC_MESSAGE_ID),
      ),
    )
    .orderBy(desc(usageEntries.ts))
    .limit(1)
    .get();
  return r ? toEntry(r) : null;
}
