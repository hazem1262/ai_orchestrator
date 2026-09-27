import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkStream } from '@orc/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OrcDb, openDb } from '../client.ts';
import { streams } from '../schema.ts';
import { getStream, upsertStream } from './streams.ts';

const T = '2026-09-17T10:00:00.000Z';
let dir: string;
let db: OrcDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'streams-repo-'));
  const opened = openDb(join(dir, 'index.db'));
  db = opened.db;
  close = opened.close;
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const stream = (title: string | null): WorkStream => ({
  ticket: 'ENG-1',
  projectId: 'wakecap',
  title,
  stage: 'implementing',
  sessionIds: ['s1'],
  prs: [],
  plans: [],
  worktrees: [],
  costUsd: 0,
  lastActivityAt: T,
});

describe('upsertStream title', () => {
  it('keeps an enriched title when a rebuild derives null, and takes a non-null derived title', () => {
    upsertStream(db, stream(null), T);
    // Same statement the stream-title enricher's store runs (createStreamTitleStore.setTitle).
    db.update(streams).set({ title: 'Linear title' }).where(eq(streams.ticket, 'ENG-1')).run();

    upsertStream(db, stream(null), T);
    expect(getStream(db, 'ENG-1')?.title).toBe('Linear title');

    upsertStream(db, stream('PR title'), T);
    expect(getStream(db, 'ENG-1')?.title).toBe('PR title');
  });
});
