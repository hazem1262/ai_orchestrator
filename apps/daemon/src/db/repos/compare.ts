import { type CompareGroup, CompareVariant } from '@orc/api-contract';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { OrcDb } from '../client.ts';
import { compareGroups } from '../schema.ts';

type Row = typeof compareGroups.$inferSelect;
const Variants = z.array(CompareVariant);

const toGroup = (r: Row): CompareGroup => ({
  id: r.id,
  projectId: r.projectId,
  prompt: r.prompt,
  ticket: r.ticket,
  repo: r.repo,
  base: r.base,
  createdAt: r.createdAt,
  state: r.state as CompareGroup['state'],
  winnerIndex: r.winnerIndex,
  estimateUsd: r.estimateUsd,
  variants: Variants.parse(JSON.parse(r.variantsJson)),
});

export function insertGroup(db: OrcDb, g: CompareGroup): CompareGroup {
  db.insert(compareGroups)
    .values({
      id: g.id,
      projectId: g.projectId,
      prompt: g.prompt,
      ticket: g.ticket,
      repo: g.repo,
      base: g.base,
      state: g.state,
      winnerIndex: g.winnerIndex,
      estimateUsd: g.estimateUsd,
      variantsJson: JSON.stringify(g.variants),
      createdAt: g.createdAt,
      updatedAt: g.createdAt,
    })
    .run();
  const saved = getGroup(db, g.id);
  if (!saved) throw new Error(`compare group ${g.id} was not saved`);
  return saved;
}

export function getGroup(db: OrcDb, id: string): CompareGroup | null {
  const row = db.select().from(compareGroups).where(eq(compareGroups.id, id)).get();
  return row ? toGroup(row) : null;
}

export function updateGroup(
  db: OrcDb,
  id: string,
  patch: Partial<Pick<CompareGroup, 'state' | 'winnerIndex' | 'variants'>>,
  now: string,
): CompareGroup {
  const set: Partial<Row> = { updatedAt: now };
  if (patch.state !== undefined) set.state = patch.state;
  if (patch.winnerIndex !== undefined) set.winnerIndex = patch.winnerIndex;
  if (patch.variants !== undefined) set.variantsJson = JSON.stringify(patch.variants);
  db.update(compareGroups).set(set).where(eq(compareGroups.id, id)).run();
  const g = getGroup(db, id);
  if (!g) throw new Error(`compare group ${id} not found`);
  return g;
}

export function listGroups(db: OrcDb, limit = 50): CompareGroup[] {
  return db
    .select()
    .from(compareGroups)
    .orderBy(desc(compareGroups.createdAt))
    .limit(limit)
    .all()
    .map(toGroup);
}

/** Newest indexed session whose start cwd is exactly `cwd` (used for Codex variants, which have no id at launch). */
export function findSessionPkByCwd(db: OrcDb, cwd: string): string | null {
  const row = db.get<{ pk: string } | undefined>(
    sql`select pk from sessions where start_cwd = ${cwd} order by started_at desc limit 1`,
  );
  return row?.pk ?? null;
}
