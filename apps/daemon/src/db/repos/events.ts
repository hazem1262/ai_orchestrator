import { SNIPPET_CLOSE, SNIPPET_OPEN } from '@orc/api-contract';
import type { EventKind, TimelineEvent, Usage } from '@orc/core';
import { redact } from '@orc/core';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { splitPk } from '../keys.ts';
import { events } from '../schema.ts';

type EventRow = typeof events.$inferSelect;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/** What FTS indexes for a tool call: the shell command, the edited path, or compact JSON. */
export function searchableInput(e: TimelineEvent): string | null {
  if (e.kind !== 'tool_call' || typeof e.input !== 'object' || e.input === null) return null;
  const i = e.input as Record<string, unknown>;
  if (typeof i.command === 'string') return i.command.slice(0, 2000);
  if (e.tool && EDIT_TOOLS.has(e.tool) && typeof i.file_path === 'string') return i.file_path;
  return JSON.stringify(i).slice(0, 2000);
}

export function insertEvents(db: OrcDb, sessionPk: string, list: TimelineEvent[]): void {
  const rows = list.map((e) => ({
    sessionPk,
    agentId: e.agentId ?? '',
    seq: e.seq,
    uuid: e.uuid,
    parentUuid: e.parentUuid,
    ts: e.ts,
    kind: e.kind,
    turn: e.turn,
    text: e.text,
    tool: e.tool,
    toolUseId: e.toolUseId,
    mcpServer: e.mcpServer,
    inputJson: e.input === null || e.input === undefined ? null : JSON.stringify(e.input),
    searchInput: searchableInput(e),
    messageId: e.messageId,
    model: e.model,
    usageJson: e.usage ? JSON.stringify(e.usage) : null,
    durationMs: e.durationMs,
  }));
  if (rows.length === 0) return;
  // One transaction across every chunk: a failure partway through (e.g. a malformed row) must
  // not leave the session with some events indexed and the rest missing.
  db.transaction((tx) => {
    for (let i = 0; i < rows.length; i += 200) {
      tx.insert(events)
        .values(rows.slice(i, i + 200))
        .onConflictDoNothing()
        .run();
    }
  });
}

export function deleteEventsFor(db: OrcDb, sessionPk: string, agentId: string | null): void {
  db.delete(events)
    .where(and(eq(events.sessionPk, sessionPk), eq(events.agentId, agentId ?? '')))
    .run();
}

function rowToEvent(r: EventRow): TimelineEvent {
  return {
    sessionId: splitPk(r.sessionPk).id,
    agentId: r.agentId === '' ? null : r.agentId,
    uuid: r.uuid,
    parentUuid: r.parentUuid,
    seq: r.seq,
    ts: r.ts,
    kind: r.kind as EventKind,
    turn: r.turn,
    text: r.text,
    tool: r.tool,
    toolUseId: r.toolUseId,
    mcpServer: r.mcpServer,
    input: r.inputJson === null ? null : (JSON.parse(r.inputJson) as unknown),
    messageId: r.messageId,
    model: r.model,
    usage: r.usageJson === null ? null : (JSON.parse(r.usageJson) as Usage),
    durationMs: r.durationMs,
  };
}

export function listEvents(
  db: OrcDb,
  sessionPk: string,
  o: { agentId?: string | null; afterSeq?: number; limit?: number },
): { items: TimelineEvent[]; nextSeq: number | null } {
  const limit = Math.min(Math.max(o.limit ?? 200, 1), 500);
  const rows = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.sessionPk, sessionPk),
        eq(events.agentId, o.agentId ?? ''),
        gt(events.seq, o.afterSeq ?? 0),
      ),
    )
    .orderBy(asc(events.seq))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit).map(rowToEvent);
  const last = page.at(-1);
  return { items: page, nextSeq: rows.length > limit && last ? last.seq : null };
}

export function countEvents(db: OrcDb, sessionPk: string): number {
  return (
    db.select({ n: sql<number>`count(*)` }).from(events).where(eq(events.sessionPk, sessionPk)).get()?.n ?? 0
  );
}

/** All sessions with at least one matching event, with the first matching event id as a snippet anchor. */
export function searchEventSessions(db: OrcDb, match: string): Map<string, number> {
  const rows = db.all<{ pk: string; rid: number }>(
    sql`SELECT e.session_pk AS pk, min(e.id) AS rid FROM events_fts JOIN events e ON e.id = events_fts.rowid WHERE events_fts MATCH ${match} GROUP BY e.session_pk`,
  );
  return new Map(rows.map((r) => [r.pk, r.rid]));
}

/**
 * Snippets leave the daemon over the API, so they are redacted the same as any other
 * transcript text before being returned — a secret in a matched tool command must never
 * surface in a search result.
 */
export function eventSnippet(db: OrcDb, match: string, rowid: number): string | null {
  const row = db.get<{ snip: string } | undefined>(
    sql`SELECT snippet(events_fts, -1, ${SNIPPET_OPEN}, ${SNIPPET_CLOSE}, '…', 12) AS snip FROM events_fts WHERE events_fts MATCH ${match} AND rowid = ${rowid}`,
  );
  return row?.snip === undefined ? null : redact(row.snip);
}

/**
 * Cheap check of how many distinct terms in `events_fts`'s dictionary a prefix would match, via
 * the `temp.events_vocab` fts5vocab shadow table created once per connection (`db/client.ts`).
 * Cost scales with the prefix's own breadth and the corpus's total vocabulary size, not with
 * `snippet()`'s cost: measured at well under 1 ms for typical prefixes against a real
 * `~/.claude`/`~/.codex` corpus (~57k distinct terms), rising to single-digit milliseconds for
 * very broad single-character prefixes (e.g. "a", "s" — ~3-7 ms), and up to ~34 ms measured at
 * worst-case cardinality under cold-cache/contended conditions (see task-19-report.md's "Fix
 * round 3" — an earlier "~1 ms" claim here understated the worst case). Still multiple orders of
 * magnitude cheaper than the FTS5 `snippet()` cost it's guarding against, and `sessions.ts`'s
 * `list()` calls it once per search (not once per result row), whether it's safe to pay that
 * `snippet()` cost or whether to fall back to a manual highlight instead.
 */
export function ftsPrefixCardinality(db: OrcDb, prefixToken: string): number {
  return (
    db.get<{ n: number }>(
      sql`SELECT count(*) AS n FROM temp.events_vocab WHERE term GLOB ${`${prefixToken}*`}`,
    )?.n ?? 0
  );
}

/** Raw text for the manual-highlight fallback `sessions.ts` uses when `ftsPrefixCardinality`
 * says FTS5's `snippet()` would be too expensive for the current query's prefix term. */
export function eventTextByRowid(
  db: OrcDb,
  rowid: number,
): { text: string | null; searchInput: string | null } | null {
  return (
    db
      .select({ text: events.text, searchInput: events.searchInput })
      .from(events)
      .where(eq(events.id, rowid))
      .get() ?? null
  );
}
