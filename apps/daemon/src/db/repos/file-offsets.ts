import { eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { fileOffsets } from '../schema.ts';

export type FileOffsetRow = typeof fileOffsets.$inferSelect;

export function getFileOffset(db: OrcDb, path: string): FileOffsetRow | null {
  return db.select().from(fileOffsets).where(eq(fileOffsets.path, path)).get() ?? null;
}

export function putFileOffset(db: OrcDb, row: FileOffsetRow): void {
  db.insert(fileOffsets).values(row).onConflictDoUpdate({ target: fileOffsets.path, set: row }).run();
}

export function deleteFileOffset(db: OrcDb, path: string): void {
  db.delete(fileOffsets).where(eq(fileOffsets.path, path)).run();
}
