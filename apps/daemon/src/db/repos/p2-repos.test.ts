import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxItem } from '@orc/core';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../client.ts';
import {
  archivedSessionPks,
  archiveTotals,
  getArchiveEntry,
  listArchiveEntries,
  upsertArchiveEntry,
} from './archive.ts';
import {
  findActiveByDedupe,
  getInboxItem,
  insertInboxItem,
  listDueSnoozed,
  listInboxItems,
  updateInboxItem,
} from './inbox.ts';
import { insertTestResult, latestTestResult, previousTestResult } from './test-results.ts';

// Every temp dir this file makes is tracked and removed when the file's tests finish. Without
// this the suite leaked ~100 directories per `pnpm test` run; 10,870 of them once filled the
// disk and produced dozens of failures that looked like flaky tests.
const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

let handle: ReturnType<typeof openDb>;
beforeEach(() => {
  handle = openDb(join(tmpDir('orc-p2db-'), 'index.db'));
});
afterEach(() => handle.close());

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'i1',
  kind: 'waiting',
  sessionId: 's-basic',
  projectId: 'wakecap',
  ticket: null,
  reason: 'Waiting: input needed',
  dedupeKey: 'waiting:claude:s-basic',
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-09-01T09:00:00.000Z',
  state: 'open',
  snoozeUntil: null,
  payload: { source: 'claude', id: 's-basic' },
  ...over,
});

describe('inbox repo', () => {
  it('inserts, reads and finds active items by dedupe key', () => {
    insertInboxItem(handle.db, item());
    expect(getInboxItem(handle.db, 'i1')?.payload).toEqual({ source: 'claude', id: 's-basic' });
    expect(findActiveByDedupe(handle.db, 'waiting:claude:s-basic')?.id).toBe('i1');
  });

  it('allows only one active item per dedupe key', () => {
    insertInboxItem(handle.db, item());
    expect(() => insertInboxItem(handle.db, item({ id: 'i2' }))).toThrow();
    updateInboxItem(handle.db, 'i1', { state: 'done', updatedAt: '2026-09-01T09:01:00.000Z' });
    expect(findActiveByDedupe(handle.db, 'waiting:claude:s-basic')).toBeNull();
    insertInboxItem(handle.db, item({ id: 'i2' }));
    expect(findActiveByDedupe(handle.db, 'waiting:claude:s-basic')?.id).toBe('i2');
  });

  it('filters by state, kind and project, newest first', () => {
    insertInboxItem(handle.db, item());
    insertInboxItem(
      handle.db,
      item({ id: 'i2', kind: 'review', dedupeKey: 'review:claude:x', updatedAt: '2026-09-01T10:00:00.000Z' }),
    );
    insertInboxItem(
      handle.db,
      item({ id: 'i3', kind: 'error', dedupeKey: 'error:claude:y', projectId: 'forza', state: 'done' }),
    );
    expect(listInboxItems(handle.db, {}).map((i) => i.id)).toEqual(['i2', 'i1', 'i3']);
    expect(listInboxItems(handle.db, { state: ['open'] }).map((i) => i.id)).toEqual(['i2', 'i1']);
    expect(listInboxItems(handle.db, { kind: ['error'] }).map((i) => i.id)).toEqual(['i3']);
    expect(listInboxItems(handle.db, { projectId: 'forza' }).map((i) => i.id)).toEqual(['i3']);
  });

  it('lists snoozed items that are due', () => {
    insertInboxItem(handle.db, item({ state: 'snoozed', snoozeUntil: '2026-09-01T09:30:00.000Z' }));
    expect(listDueSnoozed(handle.db, '2026-09-01T09:29:59.000Z')).toHaveLength(0);
    expect(listDueSnoozed(handle.db, '2026-09-01T09:30:00.000Z').map((i) => i.id)).toEqual(['i1']);
  });

  it('updates payload and reason', () => {
    insertInboxItem(handle.db, item());
    const out = updateInboxItem(handle.db, 'i1', {
      reason: 'changed',
      payload: { a: 1 },
      updatedAt: '2026-09-01T09:05:00.000Z',
    });
    expect(out.reason).toBe('changed');
    expect(out.payload).toEqual({ a: 1 });
    expect(() => updateInboxItem(handle.db, 'missing', { updatedAt: 'x' })).toThrow(/not found/);
  });
});

describe('test_results repo', () => {
  const r = (ts: string, failed: number) => ({
    ts,
    command: 'pnpm vitest run',
    passed: 3,
    failed,
    skipped: 0,
    durationMs: 1400,
  });

  it('inserts idempotently and finds previous/latest', () => {
    expect(insertTestResult(handle.db, 'claude:s', r('2026-09-01T09:00:00.000Z', 0))).toBe(true);
    expect(insertTestResult(handle.db, 'claude:s', r('2026-09-01T09:00:00.000Z', 0))).toBe(false);
    insertTestResult(handle.db, 'claude:s', r('2026-09-01T09:10:00.000Z', 2));
    expect(previousTestResult(handle.db, 'claude:s', '2026-09-01T09:10:00.000Z')?.failed).toBe(0);
    expect(previousTestResult(handle.db, 'claude:s', '2026-09-01T09:00:00.000Z')).toBeNull();
    expect(latestTestResult(handle.db, 'claude:s')?.failed).toBe(2);
    expect(latestTestResult(handle.db, 'claude:other')).toBeNull();
  });
});

describe('archive repo', () => {
  it('upserts entries and totals them', () => {
    const e = {
      path: '/c/projects/p/s-basic.jsonl',
      sessionPk: 'claude:s-basic',
      agentId: null,
      projectId: 'wakecap',
      archivePath: '/o/archive/wakecap/s-basic.jsonl.zst',
      codec: 'zstd' as const,
      sourceSize: 100,
      sourceMtimeMs: 1,
      bytes: 10,
      archivedAt: '2026-09-01T09:00:00.000Z',
    };
    upsertArchiveEntry(handle.db, e);
    upsertArchiveEntry(handle.db, { ...e, sourceSize: 200, bytes: 20 });
    upsertArchiveEntry(handle.db, {
      ...e,
      path: '/c/projects/p/s-basic/subagents/agent-a.jsonl',
      agentId: 'a',
      bytes: 5,
    });
    expect(getArchiveEntry(handle.db, e.path)?.sourceSize).toBe(200);
    expect(listArchiveEntries(handle.db, 'claude:s-basic')).toHaveLength(2);
    expect(listArchiveEntries(handle.db)).toHaveLength(2);
    expect(archiveTotals(handle.db)).toEqual({ files: 2, bytes: 25 });
    expect([...archivedSessionPks(handle.db)]).toEqual(['claude:s-basic']);
  });
});
