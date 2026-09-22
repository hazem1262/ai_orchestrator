import type { InboxItem, InboxKind, InboxState } from '@orc/core';
import { and, asc, desc, eq, inArray, lte, type SQL, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { inboxItems } from '../schema.ts';

type Row = typeof inboxItems.$inferSelect;
const ACTIVE: InboxState[] = ['open', 'snoozed'];

export interface InboxFilter {
  state?: InboxState[];
  kind?: InboxKind[];
  projectId?: string;
}

export type InboxPatch = Partial<
  Pick<InboxItem, 'reason' | 'state' | 'snoozeUntil' | 'payload' | 'ticket' | 'projectId' | 'sessionId'>
> & {
  updatedAt: string;
};

function toItem(r: Row): InboxItem {
  return {
    id: r.id,
    kind: r.kind,
    sessionId: r.sessionId,
    projectId: r.projectId,
    ticket: r.ticket,
    reason: r.reason,
    dedupeKey: r.dedupeKey,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    state: r.state,
    snoozeUntil: r.snoozeUntil,
    payload: JSON.parse(r.payloadJson) as Record<string, unknown>,
  };
}

export function insertInboxItem(db: OrcDb, item: InboxItem): void {
  const { payload, ...rest } = item;
  db.insert(inboxItems)
    .values({ ...rest, payloadJson: JSON.stringify(payload) })
    .run();
}

export function getInboxItem(db: OrcDb, id: string): InboxItem | null {
  const r = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
  return r ? toItem(r) : null;
}

export function findActiveByDedupe(db: OrcDb, dedupeKey: string): InboxItem | null {
  const r = db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.dedupeKey, dedupeKey), inArray(inboxItems.state, ACTIVE)))
    .get();
  return r ? toItem(r) : null;
}

export function updateInboxItem(db: OrcDb, id: string, patch: InboxPatch): InboxItem {
  const { payload, ...rest } = patch;
  db.update(inboxItems)
    .set({ ...rest, ...(payload ? { payloadJson: JSON.stringify(payload) } : {}) })
    .where(eq(inboxItems.id, id))
    .run();
  const out = getInboxItem(db, id);
  if (!out) throw new Error(`inbox item ${id} not found`);
  return out;
}

export function listInboxItems(db: OrcDb, f: InboxFilter): InboxItem[] {
  const conds: SQL[] = [];
  if (f.state?.length) conds.push(inArray(inboxItems.state, f.state));
  if (f.kind?.length) conds.push(inArray(inboxItems.kind, f.kind));
  if (f.projectId) conds.push(eq(inboxItems.projectId, f.projectId));
  return db
    .select()
    .from(inboxItems)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(inboxItems.updatedAt), sql`rowid asc`)
    .all()
    .map(toItem);
}

export function listDueSnoozed(db: OrcDb, nowIso: string): InboxItem[] {
  return db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.state, 'snoozed'), lte(inboxItems.snoozeUntil, nowIso)))
    .orderBy(asc(inboxItems.snoozeUntil))
    .all()
    .map(toItem);
}
