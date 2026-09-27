import { randomUUID } from 'node:crypto';
import type { Suggestion } from '@orc/api-contract';
import { desc, eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { automationSuggestions } from '../schema.ts';

export interface NewSuggestion {
  source: Suggestion['source'];
  projectId: string | null;
  title: string;
  detail: string;
  ticket: string | null;
  file: string | null;
  line: number | null;
  dedupeKey: string;
}

type Row = typeof automationSuggestions.$inferSelect;

const toSuggestion = (r: Row): Suggestion => ({
  id: r.id,
  source: r.source as Suggestion['source'],
  projectId: r.projectId,
  title: r.title,
  detail: r.detail,
  ticket: r.ticket,
  file: r.file,
  line: r.line,
  state: r.state as Suggestion['state'],
  createdAt: r.createdAt,
  decidedAt: r.decidedAt,
  runPtyId: r.runPtyId,
});

export function insertSuggestion(db: OrcDb, s: NewSuggestion, now: string): Suggestion | null {
  const row = db
    .insert(automationSuggestions)
    .values({ id: randomUUID(), ...s, state: 'new', createdAt: now })
    .onConflictDoNothing()
    .returning()
    .all()[0];
  return row ? toSuggestion(row) : null;
}

export function listSuggestions(db: OrcDb, state?: Suggestion['state']): Suggestion[] {
  const q = db.select().from(automationSuggestions);
  const rows = state
    ? q.where(eq(automationSuggestions.state, state)).orderBy(desc(automationSuggestions.createdAt)).all()
    : q.orderBy(desc(automationSuggestions.createdAt)).all();
  return rows.map(toSuggestion);
}

export function getSuggestion(db: OrcDb, id: string): Suggestion | null {
  const row = db.select().from(automationSuggestions).where(eq(automationSuggestions.id, id)).get();
  return row ? toSuggestion(row) : null;
}

export function decideSuggestion(
  db: OrcDb,
  id: string,
  state: 'accepted' | 'dismissed',
  now: string,
  runPtyId: string | null = null,
): Suggestion {
  db.update(automationSuggestions)
    .set({ state, decidedAt: now, runPtyId })
    .where(eq(automationSuggestions.id, id))
    .run();
  const s = getSuggestion(db, id);
  if (!s) throw new Error(`suggestion ${id} not found`);
  return s;
}
