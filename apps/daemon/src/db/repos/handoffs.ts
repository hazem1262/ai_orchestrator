import type { Handoff } from '@orc/core';
import { desc, eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { handoffs } from '../schema.ts';

const arr = (json: string): string[] => {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const toHandoff = (r: typeof handoffs.$inferSelect): Handoff => ({
  id: r.id,
  sessionId: r.sessionPk,
  status: r.status,
  summary: r.summary,
  evidence: arr(r.evidenceJson),
  files: arr(r.filesJson),
  nextSteps: arr(r.nextStepsJson),
  blockers: arr(r.blockersJson),
  links: arr(r.linksJson),
  createdAt: r.createdAt,
});

export function insertHandoff(db: OrcDb, h: Handoff): void {
  db.insert(handoffs)
    .values({
      id: h.id,
      sessionPk: h.sessionId,
      status: h.status,
      summary: h.summary,
      evidenceJson: JSON.stringify(h.evidence),
      filesJson: JSON.stringify(h.files),
      nextStepsJson: JSON.stringify(h.nextSteps),
      blockersJson: JSON.stringify(h.blockers),
      linksJson: JSON.stringify(h.links),
      createdAt: h.createdAt,
    })
    .run();
}

export function getHandoff(db: OrcDb, id: string): Handoff | null {
  const r = db.select().from(handoffs).where(eq(handoffs.id, id)).get();
  return r ? toHandoff(r) : null;
}

export function latestHandoff(db: OrcDb, sessionPk: string): Handoff | null {
  const r = db
    .select()
    .from(handoffs)
    .where(eq(handoffs.sessionPk, sessionPk))
    .orderBy(desc(handoffs.createdAt))
    .limit(1)
    .get();
  return r ? toHandoff(r) : null;
}
