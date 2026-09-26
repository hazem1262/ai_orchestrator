import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckpointRecord } from '@orc/core';
import { gitOut } from '../git/exec.ts';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Orchestrator',
  GIT_AUTHOR_EMAIL: 'orchestrator@localhost',
  GIT_COMMITTER_NAME: 'Orchestrator',
  GIT_COMMITTER_EMAIL: 'orchestrator@localhost',
};

/** Writes the full working tree (tracked + untracked, minus ignored) into a tree object using a throwaway index. */
export async function snapshotTree(cwd: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'orc-idx-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await gitOut(cwd, ['read-tree', 'HEAD'], { env });
    await gitOut(cwd, ['add', '-A', '--', '.'], { env });
    return await gitOut(cwd, ['write-tree'], { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function snapshotCommit(
  cwd: string,
  message: string,
): Promise<{ commit: string; tree: string }> {
  const tree = await snapshotTree(cwd);
  const parent = await gitOut(cwd, ['rev-parse', 'HEAD']);
  const commit = await gitOut(cwd, ['commit-tree', tree, '-p', parent, '-m', message], { env: IDENTITY });
  return { commit, tree };
}

const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');

export function checkpointRef(
  sessionId: string,
  turn: number,
  kind: CheckpointRecord['kind'],
  at: Date,
): string {
  const base = `refs/orchestrator/checkpoints/${safeSegment(sessionId)}/${turn}`;
  return kind === 'turn' ? base : `${base}-${kind}-${at.getTime()}-${randomUUID().slice(0, 8)}`;
}
