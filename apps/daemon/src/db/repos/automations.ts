import type {
  Automation,
  AutomationRunDetail,
  AutomationRunStatus,
  RunStats,
  TriggerSource,
} from '@orc/api-contract';
import { Automation as AutomationSchema, DiffStatSchema } from '@orc/api-contract';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { automationRuns, automations } from '../schema.ts';

export interface NewRun {
  id: string;
  automationId: string;
  triggerKey: string;
  triggerSource: TriggerSource;
  vars: Record<string, string>;
  startedAt: string;
  status: AutomationRunStatus;
  rerunOf: string | null;
}

export type RunPatch = Partial<
  Pick<
    AutomationRunDetail,
    | 'status'
    | 'endedAt'
    | 'sessionPk'
    | 'costUsd'
    | 'summary'
    | 'ptyId'
    | 'worktreePath'
    | 'prUrl'
    | 'diffStat'
    | 'error'
  >
> & { logPath?: string | null };

type AutomationRow = typeof automations.$inferSelect;
type RunRow = typeof automationRuns.$inferSelect;

function toAutomation(r: AutomationRow): Automation {
  return AutomationSchema.parse({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    trigger: JSON.parse(r.triggerJson),
    action: JSON.parse(r.actionJson),
    budgetUsd: r.budgetUsd,
  });
}

function toRun(r: RunRow): AutomationRunDetail {
  return {
    id: r.id,
    automationId: r.automationId,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    status: r.status as AutomationRunStatus,
    sessionPk: r.sessionPk,
    costUsd: r.costUsd,
    summary: r.summary,
    triggerKey: r.triggerKey,
    triggerSource: r.triggerSource as TriggerSource,
    vars: JSON.parse(r.varsJson) as Record<string, string>,
    ptyId: r.ptyId,
    worktreePath: r.worktreePath,
    prUrl: r.prUrl,
    diffStat: r.diffStatJson ? DiffStatSchema.parse(JSON.parse(r.diffStatJson)) : null,
    error: r.error,
    rerunOf: r.rerunOf,
  };
}

export function listAutomations(db: OrcDb): Automation[] {
  return db.select().from(automations).orderBy(automations.name).all().map(toAutomation);
}

export function getAutomation(db: OrcDb, id: string): Automation | null {
  const row = db.select().from(automations).where(eq(automations.id, id)).get();
  return row ? toAutomation(row) : null;
}

export function upsertAutomation(db: OrcDb, a: Automation, now: string): Automation {
  const values = {
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    triggerJson: JSON.stringify(a.trigger),
    actionJson: JSON.stringify(a.action),
    budgetUsd: a.budgetUsd,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(automations)
    .values(values)
    .onConflictDoUpdate({
      target: automations.id,
      set: {
        name: values.name,
        enabled: values.enabled,
        triggerJson: values.triggerJson,
        actionJson: values.actionJson,
        budgetUsd: values.budgetUsd,
        updatedAt: now,
      },
    })
    .run();
  const saved = getAutomation(db, a.id);
  if (!saved) throw new Error(`automation ${a.id} was not saved`);
  return saved;
}

export function deleteAutomation(db: OrcDb, id: string): void {
  db.delete(automations).where(eq(automations.id, id)).run();
}

export function insertRun(db: OrcDb, r: NewRun): AutomationRunDetail | null {
  const rows = db
    .insert(automationRuns)
    .values({
      id: r.id,
      automationId: r.automationId,
      triggerKey: r.triggerKey,
      triggerSource: r.triggerSource,
      varsJson: JSON.stringify(r.vars),
      startedAt: r.startedAt,
      status: r.status,
      rerunOf: r.rerunOf,
    })
    .onConflictDoNothing()
    .returning()
    .all();
  const row = rows[0];
  return row ? toRun(row) : null;
}

export function updateRun(db: OrcDb, id: string, patch: RunPatch): AutomationRunDetail {
  const set: Partial<RunRow> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.endedAt !== undefined) set.endedAt = patch.endedAt;
  if (patch.sessionPk !== undefined) set.sessionPk = patch.sessionPk;
  if (patch.costUsd !== undefined) set.costUsd = patch.costUsd;
  if (patch.summary !== undefined) set.summary = patch.summary;
  if (patch.ptyId !== undefined) set.ptyId = patch.ptyId;
  if (patch.worktreePath !== undefined) set.worktreePath = patch.worktreePath;
  if (patch.prUrl !== undefined) set.prUrl = patch.prUrl;
  if (patch.diffStat !== undefined) set.diffStatJson = patch.diffStat ? JSON.stringify(patch.diffStat) : null;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.logPath !== undefined) set.logPath = patch.logPath;
  if (Object.keys(set).length > 0) db.update(automationRuns).set(set).where(eq(automationRuns.id, id)).run();
  const run = getRun(db, id);
  if (!run) throw new Error(`automation run ${id} not found`);
  return run;
}

export function getRun(db: OrcDb, id: string): AutomationRunDetail | null {
  const row = db.select().from(automationRuns).where(eq(automationRuns.id, id)).get();
  return row ? toRun(row) : null;
}

export function getRunLogPath(db: OrcDb, id: string): string | null {
  return (
    db.select({ p: automationRuns.logPath }).from(automationRuns).where(eq(automationRuns.id, id)).get()?.p ??
    null
  );
}

export function listRuns(db: OrcDb, automationId: string, limit = 50): AutomationRunDetail[] {
  return db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .orderBy(desc(automationRuns.startedAt))
    .limit(limit)
    .all()
    .map(toRun);
}

export function monthSpend(db: OrcDb, automationId: string, sinceIso: string): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${automationRuns.costUsd}), 0)` })
    .from(automationRuns)
    .where(and(eq(automationRuns.automationId, automationId), gte(automationRuns.startedAt, sinceIso)))
    .get();
  return Number(row?.total ?? 0);
}

export function runStats(db: OrcDb, automationId: string, monthStartIso: string): RunStats {
  const rows = db
    .select({ status: automationRuns.status, startedAt: automationRuns.startedAt })
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .all();
  const success = rows.filter((r) => r.status === 'success').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const finished = success + failed;
  const lastRunAt =
    rows
      .map((r) => r.startedAt)
      .sort()
      .at(-1) ?? null;
  return {
    total: rows.length,
    success,
    failed,
    successRate: finished > 0 ? success / finished : null,
    lastRunAt,
    monthSpendUsd: monthSpend(db, automationId, monthStartIso),
  };
}

export function failStaleRuns(db: OrcDb, now: string): number {
  const res = db
    .update(automationRuns)
    .set({ status: 'failed', endedAt: now, error: 'daemon restarted while the run was active' })
    .where(inArray(automationRuns.status, ['queued', 'running']))
    .run();
  return res.changes;
}
