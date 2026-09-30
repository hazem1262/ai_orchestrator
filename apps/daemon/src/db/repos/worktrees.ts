import type { WorktreeOrigin, WorktreeView } from '@orc/core';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { worktrees } from '../schema.ts';

export type WorktreeRow = Omit<WorktreeView, 'prStatus' | 'repoSlug'> & {
  createdAt: string;
  archivedAt: string | null;
};

type Db = typeof worktrees.$inferSelect;

function fromDb(r: Db): WorktreeRow {
  return {
    path: r.path,
    repo: r.repo,
    branch: r.branch,
    base: r.base,
    ticket: r.ticket,
    dirty: r.dirty,
    prUrl: r.prUrl,
    state: r.state,
    createdByApp: r.createdByApp,
    head: r.head,
    isMain: r.isMain,
    origin: r.origin as WorktreeOrigin,
    sessionPks: JSON.parse(r.sessionPksJson) as string[],
    projectId: r.projectId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  };
}

export function upsertWorktree(db: OrcDb, w: WorktreeRow): void {
  const values = {
    path: w.path,
    repo: w.repo,
    branch: w.branch,
    base: w.base,
    ticket: w.ticket,
    dirty: w.dirty,
    prUrl: w.prUrl,
    state: w.state,
    createdByApp: w.createdByApp,
    head: w.head,
    isMain: w.isMain,
    origin: w.origin,
    sessionPksJson: JSON.stringify(w.sessionPks),
    projectId: w.projectId,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    archivedAt: w.archivedAt,
  };
  const { path: _path, createdAt: _createdAt, ...update } = values;
  db.insert(worktrees).values(values).onConflictDoUpdate({ target: worktrees.path, set: update }).run();
}

export function getWorktree(db: OrcDb, path: string): WorktreeRow | null {
  const r = db.select().from(worktrees).where(eq(worktrees.path, path)).get();
  return r ? fromDb(r) : null;
}

export function listWorktrees(
  db: OrcDb,
  f: { projectId?: string; state?: 'active' | 'archived'; repo?: string } = {},
): WorktreeRow[] {
  const conds: SQL[] = [];
  if (f.projectId) conds.push(eq(worktrees.projectId, f.projectId));
  if (f.state) conds.push(eq(worktrees.state, f.state));
  if (f.repo) conds.push(eq(worktrees.repo, f.repo));
  return db
    .select()
    .from(worktrees)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(worktrees.repo), asc(worktrees.path))
    .all()
    .map(fromDb);
}

export function markWorktreeArchived(db: OrcDb, path: string, at: string): void {
  db.update(worktrees)
    .set({ state: 'archived', archivedAt: at, updatedAt: at, dirty: false })
    .where(eq(worktrees.path, path))
    .run();
}
