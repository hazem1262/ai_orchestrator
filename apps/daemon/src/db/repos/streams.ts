import type { PrRef, StreamLink, StreamLinkKind, StreamStage, WorkStream } from '@orc/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { streamLinks, streams } from '../schema.ts';

const arr = <T>(json: string): T[] => {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

const toStream = (r: typeof streams.$inferSelect): WorkStream => ({
  ticket: r.ticket,
  projectId: r.projectId,
  title: r.title,
  stage: r.stage,
  sessionIds: arr<string>(r.sessionIdsJson),
  prs: arr<PrRef>(r.prsJson),
  plans: arr<string>(r.plansJson),
  worktrees: arr<string>(r.worktreesJson),
  costUsd: r.costUsd,
  lastActivityAt: r.lastActivityAt,
});

export function upsertStream(db: OrcDb, s: WorkStream, nowIso: string): void {
  const values = {
    ticket: s.ticket,
    projectId: s.projectId,
    title: s.title,
    stage: s.stage,
    sessionIdsJson: JSON.stringify(s.sessionIds),
    prsJson: JSON.stringify(s.prs),
    plansJson: JSON.stringify(s.plans),
    worktreesJson: JSON.stringify(s.worktrees),
    costUsd: s.costUsd,
    lastActivityAt: s.lastActivityAt,
    updatedAt: nowIso,
  };
  const { ticket: _t, title: _title, ...rest } = values;
  // A rebuild that derives no title keeps the stored one (set by the stream-title enricher).
  const set = { ...rest, title: sql`coalesce(excluded.title, ${streams.title})` };
  db.insert(streams).values(values).onConflictDoUpdate({ target: streams.ticket, set }).run();
}

/** Newest activity first. */
export function listStreams(db: OrcDb, q: { projectId?: string; stage?: StreamStage }): WorkStream[] {
  return db
    .select()
    .from(streams)
    .where(
      and(
        q.projectId === undefined ? undefined : eq(streams.projectId, q.projectId),
        q.stage === undefined ? undefined : eq(streams.stage, q.stage),
      ),
    )
    .orderBy(desc(streams.lastActivityAt))
    .all()
    .map(toStream);
}

export function getStream(db: OrcDb, ticket: string): WorkStream | null {
  const r = db.select().from(streams).where(eq(streams.ticket, ticket)).get();
  return r ? toStream(r) : null;
}

/** Replaces the ticket's `auto` links; `manual` rows (links and exclusions) are kept as they are. */
export function replaceAutoLinks(
  db: OrcDb,
  ticket: string,
  links: Array<{ kind: StreamLinkKind; ref: string }>,
  nowIso: string,
): void {
  db.transaction((tx) => {
    tx.delete(streamLinks)
      .where(and(eq(streamLinks.ticket, ticket), eq(streamLinks.origin, 'auto')))
      .run();
    for (const l of links) {
      tx.insert(streamLinks)
        .values({ ticket, kind: l.kind, ref: l.ref, origin: 'auto', excluded: false, createdAt: nowIso })
        .onConflictDoNothing()
        .run();
    }
  });
}

export function listLinks(db: OrcDb, ticket?: string): StreamLink[] {
  const q = db.select().from(streamLinks);
  return (ticket === undefined ? q.all() : q.where(eq(streamLinks.ticket, ticket)).all()).map((r) => ({
    ...r,
  }));
}

export function setManualLink(
  db: OrcDb,
  ticket: string,
  kind: StreamLinkKind,
  ref: string,
  excluded: boolean,
  nowIso: string,
): StreamLink {
  db.insert(streamLinks)
    .values({ ticket, kind, ref, origin: 'manual', excluded, createdAt: nowIso })
    .onConflictDoUpdate({
      target: [streamLinks.ticket, streamLinks.kind, streamLinks.ref],
      set: { origin: 'manual', excluded, createdAt: nowIso },
    })
    .run();
  return { ticket, kind, ref, origin: 'manual', excluded, createdAt: nowIso };
}
