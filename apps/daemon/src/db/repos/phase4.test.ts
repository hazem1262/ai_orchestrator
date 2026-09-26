import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrStatus } from '@orc/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OrcDb, openDb } from '../client.ts';
import {
  deleteCheckpoint,
  getCheckpoint,
  insertCheckpoint,
  listCheckpoints,
  listCheckpointsForWorktree,
} from './checkpoints.ts';
import { findPrByHead, getPrStatus, listPrStatuses, upsertPrStatus } from './pr-cache.ts';
import {
  getWorktree,
  listWorktrees,
  markWorktreeArchived,
  upsertWorktree,
  type WorktreeRow,
} from './worktrees.ts';

let dir: string;
let db: OrcDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-db4-'));
  const opened = openDb(join(dir, 'index.db'));
  db = opened.db;
  close = opened.close;
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const row = (p: Partial<WorktreeRow> = {}): WorktreeRow => ({
  path: '/r/.worktrees/feat-SAF-1-x',
  repo: '/r',
  branch: 'feat/SAF-1-x',
  base: 'main',
  ticket: 'SAF-1',
  dirty: false,
  prUrl: null,
  state: 'active',
  createdByApp: true,
  head: 'abc',
  isMain: false,
  origin: 'app',
  sessionPks: ['claude:s1'],
  projectId: 'wakecap',
  updatedAt: '2026-09-17T10:00:00.000Z',
  createdAt: '2026-09-17T09:00:00.000Z',
  archivedAt: null,
  ...p,
});

const pr = (p: Partial<PrStatus> = {}): PrStatus => ({
  pr: { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7' },
  state: 'open',
  title: 'SAF-1 x',
  checks: 'pending',
  review: 'review_required',
  updatedAt: '2026-09-17T10:00:00Z',
  headRef: 'feat/SAF-1-x',
  failedChecks: [],
  ...p,
});

describe('worktrees repo', () => {
  it('upserts, reads, filters and archives', () => {
    upsertWorktree(db, row());
    upsertWorktree(
      db,
      row({
        path: '/r',
        branch: 'main',
        isMain: true,
        origin: 'config',
        createdByApp: false,
        ticket: null,
        sessionPks: [],
      }),
    );
    upsertWorktree(db, row({ dirty: true, sessionPks: ['claude:s1', 'claude:s2'] }));
    expect(getWorktree(db, '/r/.worktrees/feat-SAF-1-x')).toMatchObject({
      dirty: true,
      sessionPks: ['claude:s1', 'claude:s2'],
    });
    expect(listWorktrees(db, { repo: '/r' })).toHaveLength(2);
    markWorktreeArchived(db, '/r/.worktrees/feat-SAF-1-x', '2026-09-18T00:00:00.000Z');
    expect(listWorktrees(db, { state: 'active' }).map((w) => w.path)).toEqual(['/r']);
    expect(getWorktree(db, '/r/.worktrees/feat-SAF-1-x')?.archivedAt).toBe('2026-09-18T00:00:00.000Z');
    expect(getWorktree(db, '/missing')).toBeNull();
  });
});

describe('checkpoints repo', () => {
  it('inserts and lists in creation order', () => {
    const base = {
      sessionPk: 'claude:s1',
      sessionId: 's1',
      worktreePath: '/r/wt',
      commit: 'c',
      kind: 'turn' as const,
    };
    insertCheckpoint(db, {
      ...base,
      id: 'b',
      turn: 2,
      ref: 'refs/orchestrator/checkpoints/s1/2',
      createdAt: '2026-09-17T10:02:00.000Z',
    });
    insertCheckpoint(db, {
      ...base,
      id: 'a',
      turn: 1,
      ref: 'refs/orchestrator/checkpoints/s1/1',
      createdAt: '2026-09-17T10:01:00.000Z',
    });
    expect(listCheckpoints(db, 'claude:s1').map((c) => c.id)).toEqual(['a', 'b']);
    expect(listCheckpointsForWorktree(db, '/r/wt')).toHaveLength(2);
    expect(getCheckpoint(db, 'a')?.ref).toBe('refs/orchestrator/checkpoints/s1/1');
    expect(() =>
      insertCheckpoint(db, {
        ...base,
        id: 'c',
        turn: 1,
        ref: 'refs/orchestrator/checkpoints/s1/1',
        createdAt: '2026-09-17T10:03:00.000Z',
      }),
    ).toThrow();
    deleteCheckpoint(db, 'a');
    expect(getCheckpoint(db, 'a')).toBeNull();
  });
});

describe('pr_cache repo', () => {
  it('upserts and finds by head', () => {
    upsertPrStatus(db, pr(), '2026-09-17T10:00:01Z');
    upsertPrStatus(db, pr({ checks: 'failure', failedChecks: ['build'] }), '2026-09-17T10:01:31Z');
    expect(getPrStatus(db, 'o/r', 7)).toMatchObject({ checks: 'failure', failedChecks: ['build'] });
    expect(findPrByHead(db, 'feat/SAF-1-x')?.pr.number).toBe(7);
    expect(findPrByHead(db, 'feat/SAF-1-x', 'other/repo')).toBeNull();
    expect(listPrStatuses(db, { state: 'merged' })).toEqual([]);
  });
});
