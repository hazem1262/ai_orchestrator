import type { AuditEntry } from '@orc/core';
import { and, desc, eq, gte, like, lte, or, type SQL, sql } from 'drizzle-orm';
import type { AuditListFilter } from '../../services/audit/audit.ts';
import type { OrcDb } from '../client.ts';
import { auditLog } from '../schema.ts';

export function insertAudit(db: OrcDb, row: AuditEntry & { sessionPk: string | null }): void {
  db.insert(auditLog)
    .values({
      id: row.id,
      ts: row.ts,
      actor: row.actor,
      actorDetail: row.actorDetail,
      action: row.action,
      target: row.target,
      sessionPk: row.sessionPk,
      paramsJson: JSON.stringify(row.params),
      result: row.result,
      error: row.error,
    })
    .run();
}

function parseParams(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function queryAudit(db: OrcDb, f: AuditListFilter): AuditEntry[] {
  const conds: SQL[] = [];
  if (f.sessionPk) conds.push(eq(auditLog.sessionPk, f.sessionPk));
  if (f.action) {
    conds.push(
      f.action.endsWith('.*')
        ? like(auditLog.action, `${f.action.slice(0, -1)}%`)
        : eq(auditLog.action, f.action),
    );
  }
  if (f.actor) conds.push(eq(auditLog.actor, f.actor));
  if (f.from) conds.push(gte(auditLog.ts, f.from));
  if (f.to) conds.push(lte(auditLog.ts, f.to));
  if (f.q) {
    const pat = `%${f.q}%`;
    const text = or(
      like(auditLog.action, pat),
      like(auditLog.target, pat),
      like(auditLog.paramsJson, pat),
      like(auditLog.error, pat),
    );
    if (text) conds.push(text);
  }
  if (f.projectId)
    conds.push(sql`${auditLog.sessionPk} IN (SELECT pk FROM sessions WHERE project_id = ${f.projectId})`);
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
  const rows = db
    .select()
    .from(auditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLog.ts), sql`rowid DESC`)
    .limit(limit)
    .all();
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    actor: r.actor,
    actorDetail: r.actorDetail,
    action: r.action,
    target: r.target,
    params: parseParams(r.paramsJson),
    result: r.result,
    error: r.error,
  }));
}
