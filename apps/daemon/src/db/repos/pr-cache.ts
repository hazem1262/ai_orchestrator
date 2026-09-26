import type { PrStatus } from '@orc/core';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { prCache } from '../schema.ts';

const toStatus = (r: typeof prCache.$inferSelect): PrStatus => ({
  pr: { repo: r.repo, number: r.number, url: r.url },
  state: r.state,
  title: r.title,
  checks: r.checks,
  review: r.review,
  updatedAt: r.updatedAt,
  headRef: r.headRef,
  failedChecks: JSON.parse(r.failedChecksJson) as string[],
});

export function upsertPrStatus(db: OrcDb, s: PrStatus, fetchedAt: string): void {
  const values = {
    key: `${s.pr.repo}#${s.pr.number}`,
    repo: s.pr.repo,
    number: s.pr.number,
    url: s.pr.url,
    state: s.state,
    title: s.title,
    checks: s.checks,
    review: s.review,
    headRef: s.headRef,
    failedChecksJson: JSON.stringify(s.failedChecks),
    updatedAt: s.updatedAt,
    fetchedAt,
  };
  const { key: _key, ...update } = values;
  db.insert(prCache).values(values).onConflictDoUpdate({ target: prCache.key, set: update }).run();
}

export function getPrStatus(db: OrcDb, repo: string, number: number): PrStatus | null {
  const r = db
    .select()
    .from(prCache)
    .where(eq(prCache.key, `${repo}#${number}`))
    .get();
  return r ? toStatus(r) : null;
}

export function findPrByHead(db: OrcDb, headRef: string, repo?: string | null): PrStatus | null {
  const conds: SQL[] = [eq(prCache.headRef, headRef)];
  if (repo) conds.push(eq(prCache.repo, repo));
  const r = db
    .select()
    .from(prCache)
    .where(and(...conds))
    .orderBy(desc(prCache.updatedAt))
    .get();
  return r ? toStatus(r) : null;
}

export function listPrStatuses(db: OrcDb, f: { state?: PrStatus['state'] } = {}): PrStatus[] {
  return db
    .select()
    .from(prCache)
    .where(f.state ? eq(prCache.state, f.state) : undefined)
    .orderBy(desc(prCache.updatedAt))
    .all()
    .map(toStatus);
}
