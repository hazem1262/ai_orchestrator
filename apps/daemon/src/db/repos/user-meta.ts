import { randomUUID } from 'node:crypto';
import type { SavedView } from '@orc/api-contract';
import { asc, eq, inArray } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { labels, pins, savedViews, sessions } from '../schema.ts';

export function sessionExists(db: OrcDb, pk: string): boolean {
  return db.select({ pk: sessions.pk }).from(sessions).where(eq(sessions.pk, pk)).get() !== undefined;
}

export function setPinned(db: OrcDb, pk: string, pinned: boolean): void {
  if (pinned) {
    db.insert(pins)
      .values({ sessionPk: pk, createdAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  } else {
    db.delete(pins).where(eq(pins.sessionPk, pk)).run();
  }
}

export function pinnedSet(db: OrcDb, pks: string[]): Set<string> {
  if (pks.length === 0) return new Set();
  const rows = db.select({ pk: pins.sessionPk }).from(pins).where(inArray(pins.sessionPk, pks)).all();
  return new Set(rows.map((r) => r.pk));
}

export function setLabels(db: OrcDb, pk: string, list: string[]): string[] {
  const unique = [...new Set(list.map((l) => l.trim()).filter(Boolean))].sort();
  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.delete(labels).where(eq(labels.sessionPk, pk)).run();
    for (const label of unique) tx.insert(labels).values({ sessionPk: pk, label, createdAt: now }).run();
  });
  return unique;
}

export function labelsFor(db: OrcDb, pks: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (pks.length === 0) return out;
  const rows = db
    .select({ pk: labels.sessionPk, label: labels.label })
    .from(labels)
    .where(inArray(labels.sessionPk, pks))
    .orderBy(asc(labels.sessionPk), asc(labels.label))
    .all();
  for (const r of rows) out.set(r.pk, [...(out.get(r.pk) ?? []), r.label]);
  return out;
}

export function allLabels(db: OrcDb): string[] {
  return db
    .selectDistinct({ label: labels.label })
    .from(labels)
    .orderBy(asc(labels.label))
    .all()
    .map((r) => r.label);
}

export function listViews(db: OrcDb): SavedView[] {
  return db
    .select()
    .from(savedViews)
    .orderBy(asc(savedViews.createdAt), asc(savedViews.name))
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      query: JSON.parse(r.queryJson) as Record<string, string>,
      createdAt: r.createdAt,
    }));
}

export function insertView(db: OrcDb, i: { name: string; query: Record<string, string> }): SavedView {
  const view: SavedView = {
    id: randomUUID(),
    name: i.name,
    query: i.query,
    createdAt: new Date().toISOString(),
  };
  db.insert(savedViews)
    .values({
      id: view.id,
      name: view.name,
      queryJson: JSON.stringify(view.query),
      createdAt: view.createdAt,
    })
    .run();
  return view;
}

export function deleteView(db: OrcDb, id: string): boolean {
  return db.delete(savedViews).where(eq(savedViews.id, id)).run().changes > 0;
}
