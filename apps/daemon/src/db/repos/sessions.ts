import { HIDDEN_LABEL } from '@orc/api-contract';
import type { Availability, Session, Source } from '@orc/core';
import { and, desc, eq, gte, lte, type SQL, type SQLWrapper, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { sessionPk } from '../keys.ts';
import { sessions } from '../schema.ts';

export type SessionRow = typeof sessions.$inferSelect;
export type SessionOrigin = 'transcript' | 'history';

export interface SessionQueryFilter {
  pks?: string[] | null;
  projectId?: string;
  source?: Source;
  ticket?: string;
  pr?: string;
  from?: string;
  to?: string;
  model?: string;
  minCost?: number;
  maxCost?: number;
  skill?: string;
  hasSubagents?: boolean;
  touchedProd?: boolean;
  availability?: Availability;
  label?: string;
  pinned?: boolean;
  includeHidden?: boolean;
  includeAutomated?: boolean;
  limit: number;
  cursor?: { lastActivityAt: string; pk: string } | null;
}

export function upsertSession(db: OrcDb, s: Session, origin: SessionOrigin = 'transcript'): void {
  const { recap: _recap, live: _live, ...data } = s;
  const row = {
    pk: sessionPk(s.source, s.id),
    source: s.source,
    id: s.id,
    projectId: s.projectId,
    startCwd: s.startCwd,
    name: s.name,
    firstPrompt: s.firstPrompt,
    lastPrompt: s.lastPrompt,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    costUsd: s.usage.costUsd,
    modelsJson: JSON.stringify(s.models),
    ticketsJson: JSON.stringify(s.tickets),
    prsJson: JSON.stringify(s.prs),
    skillsJson: JSON.stringify(s.skills),
    availability: s.availability,
    hasSubagents: s.flags.hasSubagents,
    touchedProd: s.flags.touchedProd,
    automated: s.flags.automated,
    transcriptPath: s.transcriptPath,
    origin,
    dataJson: JSON.stringify(data),
    indexedAt: new Date().toISOString(),
  };
  db.insert(sessions).values(row).onConflictDoUpdate({ target: sessions.pk, set: row }).run();
}

export function rowToSession(row: SessionRow): Session {
  const data = JSON.parse(row.dataJson) as Omit<Session, 'recap' | 'live'>;
  return {
    ...data,
    projectId: row.projectId,
    availability: row.availability as Availability,
    transcriptPath: row.transcriptPath,
    flags: { ...data.flags, hasSubagents: row.hasSubagents },
    recap: row.recap,
    live: null,
  };
}

export function getSessionByPk(db: OrcDb, pk: string): Session | null {
  const row = db.select().from(sessions).where(eq(sessions.pk, pk)).get();
  return row ? rowToSession(row) : null;
}

export function getSessionOrigin(db: OrcDb, pk: string): SessionOrigin | null {
  const row = db.select({ origin: sessions.origin }).from(sessions).where(eq(sessions.pk, pk)).get();
  return row ? (row.origin as SessionOrigin) : null;
}

export function setSessionProject(db: OrcDb, pk: string, projectId: string | null): void {
  db.update(sessions).set({ projectId }).where(eq(sessions.pk, pk)).run();
}

export function markHasSubagents(db: OrcDb, pk: string): void {
  db.update(sessions).set({ hasSubagents: true }).where(eq(sessions.pk, pk)).run();
}

export function setSessionAvailability(
  db: OrcDb,
  pk: string,
  availability: Availability,
  transcriptPath: string | null,
): void {
  db.update(sessions).set({ availability, transcriptPath }).where(eq(sessions.pk, pk)).run();
}

export function listSessionCwds(
  db: OrcDb,
): Array<{ pk: string; startCwd: string; lastActivityAt: string; projectId: string | null }> {
  return db
    .select({
      pk: sessions.pk,
      startCwd: sessions.startCwd,
      lastActivityAt: sessions.lastActivityAt,
      projectId: sessions.projectId,
    })
    .from(sessions)
    .all();
}

export function projectStats(
  db: OrcDb,
): Array<{ projectId: string; sessionCount: number; lastActivityAt: string | null }> {
  const rows = db
    .select({
      projectId: sessions.projectId,
      sessionCount: sql<number>`count(*)`,
      lastActivityAt: sql<string | null>`max(${sessions.lastActivityAt})`,
    })
    .from(sessions)
    .where(sql`${sessions.projectId} IS NOT NULL`)
    .groupBy(sessions.projectId)
    .all();
  return rows.flatMap((r) => (r.projectId === null ? [] : [{ ...r, projectId: r.projectId }]));
}

export function countSessions(db: OrcDb): number {
  return db.select({ n: sql<number>`count(*)` }).from(sessions).get()?.n ?? 0;
}

const jsonHas = (column: SQLWrapper, value: string): SQL =>
  sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${value})`;

export function querySessions(db: OrcDb, f: SessionQueryFilter): SessionRow[] {
  const c: SQL[] = [];
  if (f.pks) c.push(sql`${sessions.pk} IN (SELECT value FROM json_each(${JSON.stringify(f.pks)}))`);
  if (f.projectId) c.push(eq(sessions.projectId, f.projectId));
  if (f.source) c.push(eq(sessions.source, f.source));
  if (f.ticket) c.push(jsonHas(sessions.ticketsJson, f.ticket.toUpperCase()));
  if (f.pr) {
    c.push(
      sql`EXISTS (SELECT 1 FROM json_each(${sessions.prsJson}) WHERE json_extract(value, '$.url') = ${f.pr} OR CAST(json_extract(value, '$.number') AS TEXT) = ${f.pr})`,
    );
  }
  if (f.from) c.push(gte(sessions.lastActivityAt, f.from));
  if (f.to) c.push(lte(sessions.startedAt, f.to));
  if (f.model) c.push(jsonHas(sessions.modelsJson, f.model));
  if (f.skill) c.push(jsonHas(sessions.skillsJson, f.skill));
  if (f.minCost !== undefined) c.push(gte(sessions.costUsd, f.minCost));
  if (f.maxCost !== undefined) c.push(lte(sessions.costUsd, f.maxCost));
  if (f.hasSubagents !== undefined) c.push(eq(sessions.hasSubagents, f.hasSubagents));
  if (f.touchedProd !== undefined) c.push(eq(sessions.touchedProd, f.touchedProd));
  if (f.availability) c.push(eq(sessions.availability, f.availability));
  if (f.label) {
    c.push(sql`EXISTS (SELECT 1 FROM labels l WHERE l.session_pk = ${sessions.pk} AND l.label = ${f.label})`);
  }
  if (f.pinned) c.push(sql`EXISTS (SELECT 1 FROM pins p WHERE p.session_pk = ${sessions.pk})`);
  if (!f.includeHidden && f.label !== HIDDEN_LABEL) {
    c.push(
      sql`NOT EXISTS (SELECT 1 FROM labels l WHERE l.session_pk = ${sessions.pk} AND l.label = ${HIDDEN_LABEL})`,
    );
  }
  if (!f.includeAutomated) c.push(eq(sessions.automated, false));
  if (f.cursor) {
    const { lastActivityAt: a, pk: p } = f.cursor;
    c.push(
      sql`(${sessions.lastActivityAt} < ${a} OR (${sessions.lastActivityAt} = ${a} AND ${sessions.pk} < ${p}))`,
    );
  }
  return db
    .select()
    .from(sessions)
    .where(c.length > 0 ? and(...c) : undefined)
    .orderBy(desc(sessions.lastActivityAt), desc(sessions.pk))
    .limit(f.limit)
    .all();
}

export function searchSessionText(db: OrcDb, like: string): string[] {
  return db
    .select({ pk: sessions.pk })
    .from(sessions)
    .where(
      sql`${sessions.name} LIKE ${like} ESCAPE '\\' OR ${sessions.firstPrompt} LIKE ${like} ESCAPE '\\' OR ${sessions.lastPrompt} LIKE ${like} ESCAPE '\\'`,
    )
    .all()
    .map((r) => r.pk);
}
