import type { CheckpointRecord } from '@orc/core';
import { asc, eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { checkpoints } from '../schema.ts';

export type CheckpointInsert = CheckpointRecord & { sessionPk: string };

const toRec = (r: typeof checkpoints.$inferSelect): CheckpointInsert => ({
  id: r.id,
  sessionPk: r.sessionPk,
  sessionId: r.sessionId,
  worktreePath: r.worktreePath,
  turn: r.turn,
  ref: r.ref,
  commit: r.commit,
  kind: r.kind,
  createdAt: r.createdAt,
});

export function insertCheckpoint(db: OrcDb, c: CheckpointInsert): void {
  db.insert(checkpoints).values(c).run();
}

export function getCheckpoint(db: OrcDb, id: string): CheckpointInsert | null {
  const r = db.select().from(checkpoints).where(eq(checkpoints.id, id)).get();
  return r ? toRec(r) : null;
}

export function listCheckpoints(db: OrcDb, sessionPk: string): CheckpointInsert[] {
  return db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.sessionPk, sessionPk))
    .orderBy(asc(checkpoints.createdAt))
    .all()
    .map(toRec);
}

export function listCheckpointsForWorktree(db: OrcDb, worktreePath: string): CheckpointInsert[] {
  return db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.worktreePath, worktreePath))
    .orderBy(asc(checkpoints.createdAt))
    .all()
    .map(toRec);
}

export function deleteCheckpoint(db: OrcDb, id: string): void {
  db.delete(checkpoints).where(eq(checkpoints.id, id)).run();
}
