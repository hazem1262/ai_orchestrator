import type { Recap, RecapKind } from '@orc/core';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { recaps, sessions } from '../schema.ts';

export function findRecap(db: OrcDb, kind: RecapKind, targetKey: string, offset: number): Recap | null {
  return (
    db
      .select()
      .from(recaps)
      .where(and(eq(recaps.kind, kind), eq(recaps.targetKey, targetKey), eq(recaps.transcriptOffset, offset)))
      .get() ?? null
  );
}

export function saveRecap(db: OrcDb, r: Recap): Recap {
  const { id: _id, kind: _k, targetKey: _t, transcriptOffset: _o, ...set } = r;
  db.insert(recaps)
    .values(r)
    .onConflictDoUpdate({ target: [recaps.kind, recaps.targetKey, recaps.transcriptOffset], set })
    .run();
  return findRecap(db, r.kind, r.targetKey, r.transcriptOffset) ?? r;
}

export function latestRecap(db: OrcDb, kind: RecapKind, targetKey: string): Recap | null {
  return (
    db
      .select()
      .from(recaps)
      .where(and(eq(recaps.kind, kind), eq(recaps.targetKey, targetKey)))
      .orderBy(desc(recaps.createdAt))
      .limit(1)
      .get() ?? null
  );
}

export function spendBetween(db: OrcDb, fromIso: string, toIso: string): number {
  return (
    db
      .select({ s: sql<number>`coalesce(sum(${recaps.costUsd}), 0)` })
      .from(recaps)
      .where(and(gte(recaps.createdAt, fromIso), lt(recaps.createdAt, toIso)))
      .get()?.s ?? 0
  );
}

/** P1's sessions.recap column; P1's upsertSession never overwrites it. */
export function setSessionRecap(db: OrcDb, sessionPk: string, text: string): void {
  db.update(sessions).set({ recap: text }).where(eq(sessions.pk, sessionPk)).run();
}
