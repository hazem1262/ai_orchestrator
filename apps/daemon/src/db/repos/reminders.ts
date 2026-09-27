import type { Reminder, ReminderState } from '@orc/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { reminders } from '../schema.ts';

export function insertReminder(db: OrcDb, r: Reminder): void {
  db.insert(reminders).values(r).run();
}

export function getReminder(db: OrcDb, id: string): Reminder | null {
  return db.select().from(reminders).where(eq(reminders.id, id)).get() ?? null;
}

export function listReminders(db: OrcDb, f: { state?: ReminderState[]; sessionPk?: string }): Reminder[] {
  return db
    .select()
    .from(reminders)
    .where(
      and(
        f.state && f.state.length > 0 ? inArray(reminders.state, f.state) : undefined,
        f.sessionPk === undefined ? undefined : eq(reminders.sessionPk, f.sessionPk),
      ),
    )
    .orderBy(asc(reminders.dueAt))
    .all();
}

export function setReminderState(db: OrcDb, id: string, state: ReminderState, firedAt: string | null): void {
  db.update(reminders).set({ state, firedAt }).where(eq(reminders.id, id)).run();
}
