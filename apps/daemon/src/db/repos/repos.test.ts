import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEvent, makeSession } from '../../../test/factories.ts';
import { type OrcDb, openDb } from '../client.ts';
import { toFtsQuery } from '../fts.ts';
import { listAgents, upsertAgent } from './agents.ts';
import {
  countEvents,
  deleteEventsFor,
  eventSnippet,
  insertEvents,
  listEvents,
  searchEventSessions,
} from './events.ts';
import { deleteFileOffset, getFileOffset, putFileOffset } from './file-offsets.ts';
import { historyPromptsFor, insertHistoryPrompts, searchHistoryPrompts } from './history.ts';
import { listProjectRows, replaceProjects } from './projects.ts';
import {
  getSessionByPk,
  getSessionOrigin,
  listSessionCwds,
  markHasSubagents,
  projectStats,
  querySessions,
  searchSessionText,
  setSessionAvailability,
  setSessionProject,
  upsertSession,
} from './sessions.ts';
import {
  allLabels,
  deleteView,
  insertView,
  labelsFor,
  listViews,
  pinnedSet,
  setLabels,
  setPinned,
} from './user-meta.ts';

let db: OrcDb;
let raw: Database.Database;
let close: () => void;
beforeEach(() => {
  const opened = openDb(join(mkdtempSync(join(tmpdir(), 'orc-repo-')), 'index.db'));
  db = opened.db;
  raw = opened.raw;
  close = opened.close;
});
afterEach(() => close());

function seed() {
  upsertSession(
    db,
    makeSession({
      id: 'a',
      name: 'Weekend SLA',
      firstPrompt: 'implement SAF-1 weekend rule',
      tickets: ['SAF-1'],
      prs: [{ repo: 'o/r', number: 231, url: 'https://github.com/o/r/pull/231' }],
      models: ['claude-opus-5'],
      skills: ['conductor'],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1.5 },
      lastActivityAt: '2026-09-01T10:00:00.000Z',
    }),
  );
  upsertSession(
    db,
    makeSession({
      id: 'b',
      source: 'codex',
      projectId: 'forza',
      startCwd: '/Users/test/Forza',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.1 },
      flags: { touchedProd: false, hasSubagents: false, automated: true },
      lastActivityAt: '2026-09-01T11:00:00.000Z',
    }),
  );
  upsertSession(
    db,
    makeSession({
      id: 'c',
      availability: 'prompts-only',
      flags: { touchedProd: true, hasSubagents: true, automated: false },
      lastActivityAt: '2026-09-01T09:00:00.000Z',
    }),
    'history',
  );
  upsertSession(db, makeSession({ id: 'd', lastActivityAt: '2026-09-01T08:00:00.000Z' }));
  setLabels(db, 'claude:d', ['hidden']);
}

const pks = (f: Parameters<typeof querySessions>[1]) => querySessions(db, f).map((r) => r.pk);

describe('sessions repo', () => {
  it('round-trips a session and keeps recap on re-upsert', () => {
    seed();
    raw.prepare("update sessions set recap = 'R' where pk = 'claude:a'").run();
    upsertSession(db, makeSession({ id: 'a', name: 'Renamed' }));
    const s = getSessionByPk(db, 'claude:a');
    expect(s).toMatchObject({ id: 'a', name: 'Renamed', recap: 'R', live: null });
    expect(getSessionByPk(db, 'claude:zzz')).toBeNull();
    expect(getSessionOrigin(db, 'claude:c')).toBe('history');
    expect(getSessionOrigin(db, 'claude:a')).toBe('transcript');
  });

  it('applies column overrides', () => {
    seed();
    setSessionProject(db, 'claude:a', 'other');
    markHasSubagents(db, 'claude:a');
    setSessionAvailability(db, 'claude:a', 'prompts-only', null);
    expect(getSessionByPk(db, 'claude:a')).toMatchObject({
      projectId: 'other',
      availability: 'prompts-only',
      transcriptPath: null,
      flags: { hasSubagents: true },
    });
    expect(listSessionCwds(db)).toHaveLength(4);
  });

  it('filters and orders', () => {
    seed();
    expect(pks({ limit: 10 })).toEqual(['claude:a', 'claude:c']);
    expect(pks({ limit: 10, includeAutomated: true })).toEqual(['codex:b', 'claude:a', 'claude:c']);
    expect(pks({ limit: 10, includeHidden: true })).toEqual(['claude:a', 'claude:c', 'claude:d']);
    expect(pks({ limit: 10, label: 'hidden' })).toEqual(['claude:d']);
    expect(pks({ limit: 10, projectId: 'forza', includeAutomated: true })).toEqual(['codex:b']);
    expect(pks({ limit: 10, source: 'claude', ticket: 'saf-1' })).toEqual(['claude:a']);
    expect(pks({ limit: 10, pr: '231' })).toEqual(['claude:a']);
    expect(pks({ limit: 10, pr: 'https://github.com/o/r/pull/231' })).toEqual(['claude:a']);
    expect(pks({ limit: 10, model: 'claude-opus-5' })).toEqual(['claude:a']);
    expect(pks({ limit: 10, skill: 'conductor' })).toEqual(['claude:a']);
    expect(pks({ limit: 10, minCost: 1, includeAutomated: true })).toEqual(['claude:a']);
    expect(pks({ limit: 10, maxCost: 1, includeAutomated: true })).toEqual(['codex:b']);
    expect(pks({ limit: 10, touchedProd: true })).toEqual(['claude:c']);
    expect(pks({ limit: 10, hasSubagents: true })).toEqual(['claude:c']);
    expect(pks({ limit: 10, availability: 'prompts-only' })).toEqual(['claude:c']);
    expect(pks({ limit: 10, from: '2026-09-01T09:30:00.000Z' })).toEqual(['claude:a']);
    expect(pks({ limit: 10, pks: ['claude:c'] })).toEqual(['claude:c']);
    expect(pks({ limit: 10, pks: [] })).toEqual([]);
    setPinned(db, 'claude:c', true);
    expect(pks({ limit: 10, pinned: true })).toEqual(['claude:c']);
  });

  it('paginates with a cursor', () => {
    seed();
    const first = querySessions(db, { limit: 1, includeAutomated: true });
    expect(first.map((r) => r.pk)).toEqual(['codex:b']);
    const row = first[0];
    if (!row) throw new Error('missing row');
    expect(
      pks({ limit: 5, includeAutomated: true, cursor: { lastActivityAt: row.lastActivityAt, pk: row.pk } }),
    ).toEqual(['claude:a', 'claude:c']);
  });

  it('searches names and prompts with LIKE and reports project stats', () => {
    seed();
    expect(searchSessionText(db, '%weekend%')).toEqual(['claude:a']);
    expect(projectStats(db)).toEqual(
      expect.arrayContaining([
        { projectId: 'wakecap', sessionCount: 3, lastActivityAt: '2026-09-01T10:00:00.000Z' },
        { projectId: 'forza', sessionCount: 1, lastActivityAt: '2026-09-01T11:00:00.000Z' },
      ]),
    );
  });
});

describe('events repo', () => {
  const events = [
    makeEvent({ seq: 1, kind: 'prompt', text: 'fix the notification service' }),
    makeEvent({
      seq: 2,
      kind: 'tool_call',
      tool: 'Bash',
      toolUseId: 't1',
      input: { command: 'PGPASSWORD=x psql -h db' },
    }),
    makeEvent({ seq: 3, kind: 'tool_result', toolUseId: 't1', text: 'notification rows: 3' }),
    makeEvent({
      seq: 4,
      kind: 'assistant_text',
      text: 'Done.',
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: null },
      messageId: 'm1',
      model: 'claude-opus-5',
    }),
    makeEvent({ seq: 1, agentId: 'ag1', kind: 'prompt', text: 'subagent notification task' }),
  ];

  it('rolls back the whole batch if a chunk mid-insert fails', () => {
    // 250 valid rows (spans two 200-row chunks) followed by one row with a NOT NULL column
    // forced to undefined, which SQLite rejects partway through the second chunk's insert.
    // Nothing from this call should land in the table — the whole batch is one transaction.
    const many = Array.from({ length: 250 }, (_, i) => makeEvent({ seq: i + 1, text: `e${i}` }));
    const bad = { ...makeEvent({ seq: 251 }), kind: undefined as unknown as 'prompt' };
    expect(() => insertEvents(db, 'claude:batch', [...many, bad])).toThrow();
    expect(countEvents(db, 'claude:batch')).toBe(0);
  });

  it('inserts idempotently and pages by seq per agent', () => {
    insertEvents(db, 'claude:s', events);
    insertEvents(db, 'claude:s', events);
    expect(countEvents(db, 'claude:s')).toBe(5);
    const p1 = listEvents(db, 'claude:s', { limit: 2 });
    expect(p1.items.map((e) => e.seq)).toEqual([1, 2]);
    expect(p1.nextSeq).toBe(2);
    expect(p1.items[1]?.input).toEqual({ command: 'PGPASSWORD=x psql -h db' });
    const p2 = listEvents(db, 'claude:s', { afterSeq: 2, limit: 2 });
    expect(p2.items.map((e) => e.seq)).toEqual([3, 4]);
    expect(p2.nextSeq).toBeNull();
    expect(p2.items[1]).toMatchObject({
      sessionId: 's',
      agentId: null,
      usage: { output: 2 },
      model: 'claude-opus-5',
    });
    const sub = listEvents(db, 'claude:s', { agentId: 'ag1' });
    expect(sub.items).toHaveLength(1);
    expect(sub.items[0]?.agentId).toBe('ag1');
  });

  it('finds sessions by FTS, excludes tool results and returns snippets', () => {
    insertEvents(db, 'claude:s', events);
    insertEvents(db, 'claude:other', [makeEvent({ seq: 1, text: 'unrelated' })]);
    const match = toFtsQuery('notification') ?? '';
    const hits = searchEventSessions(db, match);
    expect([...hits.keys()]).toEqual(['claude:s']);
    const snip = eventSnippet(db, match, hits.get('claude:s') ?? -1);
    expect(snip).toContain('⟦notification⟧');
    expect(searchEventSessions(db, toFtsQuery('rows') ?? '').size).toBe(0);
    expect(searchEventSessions(db, toFtsQuery('psql') ?? '').size).toBe(1);
    deleteEventsFor(db, 'claude:s', null);
    expect(countEvents(db, 'claude:s')).toBe(1);
    expect(searchEventSessions(db, match).size).toBe(1);
    deleteEventsFor(db, 'claude:s', 'ag1');
    expect(searchEventSessions(db, match).size).toBe(0);
  });

  it('never throws on adversarial user search input once sanitised by toFtsQuery', () => {
    insertEvents(db, 'claude:s', events);
    // Each of these is a raw, unsanitised string a user might type into the search box.
    // toFtsQuery must turn every one into either null (skip the search) or a syntactically
    // valid FTS5 MATCH string — searchEventSessions must never throw a SQLite syntax error.
    const raw = ['-', '"', '""', '"unterminated', 'AND OR NEAR', 'foo NEAR/2 bar', 'a AND (b OR c)', '   '];
    for (const input of raw) {
      const match = toFtsQuery(input);
      if (match === null) continue; // the daemon route skips the query entirely in this case
      expect(() => searchEventSessions(db, match)).not.toThrow();
    }
    // A query that is syntactically fine but matches nothing.
    expect(searchEventSessions(db, toFtsQuery('zzz-nonexistent-term') ?? '').size).toBe(0);
  });

  it('redacts a secret out of a search snippet before it leaves the daemon', () => {
    insertEvents(db, 'claude:secret', [
      makeEvent({
        seq: 1,
        kind: 'tool_call',
        tool: 'Bash',
        toolUseId: 't1',
        input: { command: 'PGPASSWORD=hunter2 psql -h db -c "select 1"' },
      }),
    ]);
    const match = toFtsQuery('psql') ?? '';
    const hits = searchEventSessions(db, match);
    const rowid = hits.get('claude:secret');
    expect(rowid).toBeDefined();
    const snip = eventSnippet(db, match, rowid ?? -1);
    expect(snip).not.toBeNull();
    expect(snip).not.toContain('hunter2');
    expect(snip).toContain('«redacted:secret»');
    expect(snip).toContain('⟦psql⟧');
  });
});

describe('small repos', () => {
  it('agents', () => {
    upsertAgent(db, 'claude:s', {
      id: 'ag1',
      sessionId: 's',
      parentId: null,
      depth: 1,
      agentType: 'Explore',
      description: 'd',
      background: true,
      toolUseId: 't',
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: null },
      startedAt: '2026-09-06T08:00:03.000Z',
      endedAt: null,
      status: 'done',
      transcriptPath: '/p',
    });
    expect(listAgents(db, 'claude:s')).toEqual([
      expect.objectContaining({
        id: 'ag1',
        background: true,
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: null },
      }),
    ]);
  });

  it('file offsets', () => {
    const row = {
      path: '/f.jsonl',
      kind: 'claude-main',
      sessionPk: 'claude:s',
      agentId: null,
      size: 10,
      mtimeMs: 5,
      offset: 10,
      stateJson: '{}',
      headFingerprint: null,
      updatedAt: 'now',
    };
    putFileOffset(db, row);
    putFileOffset(db, { ...row, offset: 20 });
    expect(getFileOffset(db, '/f.jsonl')?.offset).toBe(20);
    deleteFileOffset(db, '/f.jsonl');
    expect(getFileOffset(db, '/f.jsonl')).toBeNull();
  });

  it('history prompts', () => {
    const p = {
      sessionId: 'h',
      ts: '2026-01-01T00:00:00.000Z',
      display: 'old 100% prompt',
      project: '/Users/test/Wakecap',
    };
    insertHistoryPrompts(db, [p, p, { ...p, ts: '2026-01-02T00:00:00.000Z', display: 'second' }]);
    expect(historyPromptsFor(db, 'h').map((x) => x.display)).toEqual(['old 100% prompt', 'second']);
    expect(searchHistoryPrompts(db, '%100\\%%')).toEqual([{ pk: 'claude:h', display: 'old 100% prompt' }]);
  });

  it('projects mirror', () => {
    replaceProjects(db, [{ id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/w'], hidden: false }]);
    replaceProjects(db, [{ id: 'forza', name: 'Forza', pathPrefixes: ['/f'], hidden: true }]);
    expect(listProjectRows(db)).toEqual([{ id: 'forza', name: 'Forza', pathPrefixes: ['/f'], hidden: true }]);
  });

  it('pins, labels and saved views', () => {
    setPinned(db, 'claude:a', true);
    setPinned(db, 'claude:a', true);
    expect([...pinnedSet(db, ['claude:a', 'claude:b'])]).toEqual(['claude:a']);
    setPinned(db, 'claude:a', false);
    expect(pinnedSet(db, ['claude:a']).size).toBe(0);
    expect(setLabels(db, 'claude:a', ['later', 'bug', 'later'])).toEqual(['bug', 'later']);
    setLabels(db, 'claude:b', ['bug']);
    expect(labelsFor(db, ['claude:a', 'claude:b'])).toEqual(
      new Map([
        ['claude:a', ['bug', 'later']],
        ['claude:b', ['bug']],
      ]),
    );
    expect(allLabels(db)).toEqual(['bug', 'later']);
    expect(pinnedSet(db, []).size).toBe(0);
    const v = insertView(db, { name: 'Prod', query: { touchedProd: 'true' } });
    expect(listViews(db)).toEqual([v]);
    expect(deleteView(db, v.id)).toBe(true);
    expect(deleteView(db, v.id)).toBe(false);
  });
});
