import { eq, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { archiveEntries } from '../schema.ts';

export type ArchiveCodecName = 'zstd' | 'gzip';
export interface ArchiveEntry {
  path: string;
  sessionPk: string;
  agentId: string | null;
  projectId: string;
  archivePath: string;
  codec: ArchiveCodecName;
  sourceSize: number;
  sourceMtimeMs: number;
  bytes: number;
  archivedAt: string;
}

export function getArchiveEntry(db: OrcDb, path: string): ArchiveEntry | null {
  return db.select().from(archiveEntries).where(eq(archiveEntries.path, path)).get() ?? null;
}

export function upsertArchiveEntry(db: OrcDb, e: ArchiveEntry): void {
  const { path, ...rest } = e;
  db.insert(archiveEntries).values(e).onConflictDoUpdate({ target: archiveEntries.path, set: rest }).run();
  void path;
}

export function listArchiveEntries(db: OrcDb, sessionPk?: string): ArchiveEntry[] {
  const q = db.select().from(archiveEntries);
  return (sessionPk ? q.where(eq(archiveEntries.sessionPk, sessionPk)) : q).all();
}

export function archiveTotals(db: OrcDb): { files: number; bytes: number } {
  const r = db
    .select({ files: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${archiveEntries.bytes}), 0)` })
    .from(archiveEntries)
    .get();
  return { files: Number(r?.files ?? 0), bytes: Number(r?.bytes ?? 0) };
}

export function archivedSessionPks(db: OrcDb): Set<string> {
  return new Set(
    db
      .selectDistinct({ pk: archiveEntries.sessionPk })
      .from(archiveEntries)
      .all()
      .map((r) => r.pk),
  );
}
