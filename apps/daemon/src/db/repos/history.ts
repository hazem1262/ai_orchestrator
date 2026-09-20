import type { HistoryPrompt } from '@orc/core';
import { asc, eq, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { historyPrompts } from '../schema.ts';

export function insertHistoryPrompts(db: OrcDb, prompts: HistoryPrompt[]): void {
  if (prompts.length === 0) return;
  // One transaction across every chunk: a failure partway through must not leave some of a
  // session's history prompts indexed while the rest are missing.
  db.transaction((tx) => {
    for (let i = 0; i < prompts.length; i += 500) {
      const chunk = prompts.slice(i, i + 500);
      if (chunk.length > 0) tx.insert(historyPrompts).values(chunk).onConflictDoNothing().run();
    }
  });
}

export function historyPromptsFor(db: OrcDb, sessionId: string): HistoryPrompt[] {
  return db
    .select()
    .from(historyPrompts)
    .where(eq(historyPrompts.sessionId, sessionId))
    .orderBy(asc(historyPrompts.ts))
    .all();
}

export function searchHistoryPrompts(
  db: OrcDb,
  like: string,
  limit = 500,
): Array<{ pk: string; display: string }> {
  return db.all<{ pk: string; display: string }>(
    sql`SELECT 'claude:' || session_id AS pk, min(display) AS display FROM history_prompts WHERE display LIKE ${like} ESCAPE '\\' GROUP BY session_id LIMIT ${limit}`,
  );
}
