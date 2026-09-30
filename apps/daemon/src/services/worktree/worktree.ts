import type { WorktreeCleanupPreview, WorktreeCleanupResult } from '@orc/api-contract';
import { type AuditActor, branchName as coreBranchName, type Worktree, type WorktreeView } from '@orc/core';
import type { z } from 'zod';
import type { DaemonContext } from '../../context.ts';
import { cleanupPreview, runCleanup } from './cleanup.ts';
import {
  discoverWorktrees,
  findWorktreeByCwd,
  getWorktreeView,
  listWorktreeViews,
  type WorktreeDeps,
} from './worktree-read.ts';
import { archiveWorktree, syncPreview, syncToMain } from './worktree-sync.ts';
import { createWorktree, openWorktree, runWorktreeScript } from './worktree-write.ts';

export interface CreateWorktreeInput {
  repo: string;
  base: string;
  type: 'feat' | 'fix' | 'chore' | 'docs' | 'refactor';
  ticket: string | null;
  slug: string;
}

export interface SyncPreviewResult {
  path: string;
  mainPath: string;
  files: string[];
  mainDirty: string[];
}

export interface WorktreeService {
  discover(): Promise<Worktree[]>;
  create(i: CreateWorktreeInput): Promise<Worktree>;
  runScript(path: string, which: 'setup' | 'run' | 'archive'): Promise<{ ptyId: string }>;
  syncToMain(path: string): Promise<{ files: number }>;
  archive(path: string): Promise<void>;
  branchName(i: Pick<CreateWorktreeInput, 'type' | 'ticket' | 'slug'>): string;
  list(filter?: { projectId?: string; state?: Worktree['state']; repo?: string }): WorktreeView[];
  get(path: string): WorktreeView | null;
  findByCwd(cwd: string): WorktreeView | null;
  syncPreview(path: string): Promise<SyncPreviewResult>;
  archiveAs(path: string, actor: AuditActor, opts?: { allowExternal?: boolean }): Promise<void>;
  createWith(
    i: CreateWorktreeInput,
    opts: { runSetup: boolean; actor: AuditActor },
  ): Promise<{ view: WorktreeView; setupPtyId: string | null }>;
  open(path: string, target: 'vscode' | 'terminal' | 'finder'): Promise<void>;
  /** Merged, non-main active worktrees that `cleanup` would archive, and merged ones it would skip. */
  cleanupPreview(filter: { projectId?: string }): Promise<z.infer<typeof WorktreeCleanupPreview>>;
  /** Re-checks each path and archives the merged, clean ones as the user, app-created or not. */
  cleanup(paths: string[]): Promise<z.infer<typeof WorktreeCleanupResult>>;
}

export function createWorktreeService(
  ctx: DaemonContext,
  opts: { now?: () => Date; claudeJson?: string; opener?: WorktreeDeps['opener'] } = {},
): WorktreeService {
  const d: WorktreeDeps = {
    ctx,
    now: opts.now ?? (() => new Date()),
    ...(opts.claudeJson ? { claudeJson: opts.claudeJson } : {}),
    ...(opts.opener ? { opener: opts.opener } : {}),
  };
  let running: Promise<WorktreeView[]> | null = null;
  return {
    discover: () => {
      running ??= discoverWorktrees(d).finally(() => {
        running = null;
      });
      return running;
    },
    create: async (i) => (await createWorktree(d, i, { runSetup: true, actor: 'user' })).view,
    createWith: (i, o) => createWorktree(d, i, o),
    runScript: (path, which) => runWorktreeScript(d, path, which, 'user'),
    syncToMain: (path) => syncToMain(d, path, 'user'),
    syncPreview: (path) => syncPreview(d, path),
    archive: (path) => archiveWorktree(d, path, 'user', { allowExternal: false }),
    archiveAs: (path, actor, o) => archiveWorktree(d, path, actor, o),
    branchName: (i) => coreBranchName(i),
    list: (f) => listWorktreeViews(d, f),
    get: (path) => getWorktreeView(d, path),
    findByCwd: (cwd) => findWorktreeByCwd(d, cwd),
    open: (path, target) => openWorktree(d, path, target),
    cleanupPreview: (f) => cleanupPreview(d, f),
    cleanup: (paths) =>
      runCleanup(d, paths, (path) => archiveWorktree(d, path, 'user', { allowExternal: true })),
  };
}
