import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { AuditActor, CheckpointRecord } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import {
  type CheckpointInsert,
  deleteCheckpoint,
  getCheckpoint,
  insertCheckpoint,
  listCheckpoints,
  listCheckpointsForWorktree,
} from '../../db/repos/checkpoints.ts';
import { getWorktree } from '../../db/repos/worktrees.ts';
import { runAudited } from '../git/audit.ts';
import { git, gitOut } from '../git/exec.ts';
import { checkpointRef, snapshotCommit, snapshotTree } from './snapshot.ts';

export interface CheckpointService {
  create(sessionPk: string, worktreePath: string, turn: number): Promise<CheckpointRecord>;
  list(sessionPk: string): CheckpointRecord[];
  rewind(checkpointId: string): Promise<CheckpointRecord>;
  diff(fromRef: string, toRef: string | 'WORKTREE', cwd: string): Promise<string>;
  get(id: string): CheckpointRecord | null;
  createAs(
    sessionPk: string,
    worktreePath: string,
    turn: number,
    kind: CheckpointRecord['kind'],
    actor: AuditActor,
  ): Promise<CheckpointRecord>;
  pruneForWorktree(worktreePath: string): Promise<number>;
}

const strip = ({ sessionPk: _pk, ...rest }: CheckpointInsert): CheckpointRecord => rest;
const nativeId = (pk: string) => pk.slice(pk.indexOf(':') + 1);

export function createCheckpointService(
  ctx: DaemonContext,
  opts: { now?: () => Date } = {},
): CheckpointService {
  const now = opts.now ?? (() => new Date());

  async function dropRef(cwd: string, ref: string): Promise<void> {
    await git(cwd, ['update-ref', '-d', ref], { allowFail: true });
  }

  async function createAs(
    sessionPk: string,
    worktreePath: string,
    turn: number,
    kind: CheckpointRecord['kind'],
    actor: AuditActor,
  ) {
    return runAudited(ctx, actor, 'checkpoint.create', worktreePath, { sessionPk, turn, kind }, async () => {
      const at = now();
      const sessionId = nativeId(sessionPk);
      const ref = checkpointRef(sessionId, turn, kind, at);
      const { commit } = await snapshotCommit(
        worktreePath,
        `orchestrator checkpoint ${sessionId} turn ${turn} (${kind})`,
      );
      await gitOut(worktreePath, ['update-ref', ref, commit]);
      const existing = listCheckpoints(ctx.db, sessionPk).find((c) => c.ref === ref);
      if (existing) deleteCheckpoint(ctx.db, existing.id);
      const rec: CheckpointInsert = {
        id: randomUUID(),
        sessionPk,
        sessionId,
        worktreePath,
        turn,
        ref,
        commit,
        kind,
        createdAt: at.toISOString(),
      };
      insertCheckpoint(ctx.db, rec);

      const cap = ctx.config().worktrees.checkpointsPerSession;
      const turns = listCheckpoints(ctx.db, sessionPk).filter((c) => c.kind === 'turn');
      for (const old of turns.slice(0, Math.max(0, turns.length - cap))) {
        await dropRef(worktreePath, old.ref);
        deleteCheckpoint(ctx.db, old.id);
      }
      const out = strip(rec);
      ctx.bus.emit({ type: 'checkpoint.created', checkpoint: out });
      return out;
    });
  }

  async function diff(fromRef: string, toRef: string | 'WORKTREE', cwd: string): Promise<string> {
    const to = toRef === 'WORKTREE' ? await snapshotTree(cwd) : toRef;
    const r = await git(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', fromRef, to]);
    return r.stdout;
  }

  async function rewind(checkpointId: string): Promise<CheckpointRecord> {
    const cp = getCheckpoint(ctx.db, checkpointId);
    if (!cp) throw new Error(`not_found: checkpoint ${checkpointId}`);
    return runAudited(
      ctx,
      'user',
      'checkpoint.rewind',
      cp.worktreePath,
      { checkpointId, ref: cp.ref },
      async () => {
        const safety = await createAs(cp.sessionPk, cp.worktreePath, cp.turn, 'safety', 'user');
        await gitOut(cp.worktreePath, ['restore', `--source=${cp.commit}`, '--worktree', '--', '.']);
        const added = (
          await gitOut(cp.worktreePath, [
            'diff',
            '--name-only',
            '--no-renames',
            '--diff-filter=A',
            '-z',
            cp.commit,
            safety.commit,
          ])
        )
          .split('\0')
          .filter((f) => f !== '');
        const root = resolve(cp.worktreePath);
        for (const rel of added) {
          const abs = resolve(join(root, rel));
          if (abs.startsWith(root + sep) && existsSync(abs)) rmSync(abs);
        }
        return safety;
      },
    );
  }

  async function pruneForWorktree(worktreePath: string): Promise<number> {
    const rows = listCheckpointsForWorktree(ctx.db, worktreePath);
    const cwd = existsSync(worktreePath) ? worktreePath : (getWorktree(ctx.db, worktreePath)?.repo ?? null);
    for (const row of rows) {
      if (cwd) await dropRef(cwd, row.ref);
      deleteCheckpoint(ctx.db, row.id);
    }
    return rows.length;
  }

  ctx.bus.on('worktree.removed', (e) => {
    pruneForWorktree(e.path).catch((err: unknown) =>
      ctx.log.warn({ err, path: e.path }, 'checkpoint prune failed'),
    );
  });

  return {
    create: (pk, path, turn) => createAs(pk, path, turn, 'turn', 'automation'),
    createAs,
    list: (pk) => listCheckpoints(ctx.db, pk).map(strip),
    get: (id) => {
      const c = getCheckpoint(ctx.db, id);
      return c ? strip(c) : null;
    },
    diff,
    rewind,
    pruneForWorktree,
  };
}
