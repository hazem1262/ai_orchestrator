import { eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { slackThreads } from '../schema-p6.ts';

export interface SlackThread {
  inboxItemId: string;
  sessionPk: string | null;
  channel: string;
  rootTs: string;
  lastSeenTs: string;
  appTs: string[];
  reactionsDone: string[];
  state: 'open' | 'resolved';
  createdAt: string;
  updatedAt: string;
}

type Row = typeof slackThreads.$inferSelect;
const toThread = (r: Row): SlackThread => ({
  inboxItemId: r.inboxItemId,
  sessionPk: r.sessionPk,
  channel: r.channel,
  rootTs: r.rootTs,
  lastSeenTs: r.lastSeenTs,
  appTs: JSON.parse(r.appTsJson) as string[],
  reactionsDone: JSON.parse(r.reactionsDoneJson) as string[],
  state: r.state as SlackThread['state'],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export function insertSlackThread(db: OrcDb, t: SlackThread): void {
  db.insert(slackThreads)
    .values({
      inboxItemId: t.inboxItemId,
      sessionPk: t.sessionPk,
      channel: t.channel,
      rootTs: t.rootTs,
      lastSeenTs: t.lastSeenTs,
      appTsJson: JSON.stringify(t.appTs),
      reactionsDoneJson: JSON.stringify(t.reactionsDone),
      state: t.state,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })
    .run();
}

export function getSlackThread(db: OrcDb, inboxItemId: string): SlackThread | null {
  const r = db.select().from(slackThreads).where(eq(slackThreads.inboxItemId, inboxItemId)).get();
  return r ? toThread(r) : null;
}

export function listOpenSlackThreads(db: OrcDb): SlackThread[] {
  return db.select().from(slackThreads).where(eq(slackThreads.state, 'open')).all().map(toThread);
}

export function updateSlackThread(
  db: OrcDb,
  inboxItemId: string,
  patch: Partial<Pick<SlackThread, 'lastSeenTs' | 'appTs' | 'reactionsDone' | 'state'>>,
  at: string,
): void {
  const set: Partial<typeof slackThreads.$inferInsert> = { updatedAt: at };
  if (patch.lastSeenTs !== undefined) set.lastSeenTs = patch.lastSeenTs;
  if (patch.appTs !== undefined) set.appTsJson = JSON.stringify(patch.appTs);
  if (patch.reactionsDone !== undefined) set.reactionsDoneJson = JSON.stringify(patch.reactionsDone);
  if (patch.state !== undefined) set.state = patch.state;
  db.update(slackThreads).set(set).where(eq(slackThreads.inboxItemId, inboxItemId)).run();
}
