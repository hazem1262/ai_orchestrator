import type { DigestRecord } from '@orc/core';
import { desc } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { digests } from '../schema.ts';

export function upsertDigest(db: OrcDb, d: DigestRecord): void {
  db.insert(digests)
    .values(d)
    .onConflictDoUpdate({ target: digests.weekStart, set: { markdown: d.markdown, createdAt: d.createdAt } })
    .run();
}

export function latestDigest(db: OrcDb): DigestRecord | null {
  return db.select().from(digests).orderBy(desc(digests.weekStart)).limit(1).get() ?? null;
}
