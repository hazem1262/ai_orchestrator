import { randomUUID } from 'node:crypto';
import { type AuditActor, type AuditEntry, type DenyVerdict, redact } from '@orc/core';
import type { OrcDb } from '../../db/client.ts';
import { insertAudit, queryAudit } from '../../db/repos/audit.ts';
import type { EventBus } from '../../live/event-bus.ts';
import { redactParams } from './redact-params.ts';

export interface AuditListFilter {
  sessionPk?: string;
  action?: string;
  actor?: AuditActor;
  from?: string;
  to?: string;
  limit?: number;
  q?: string;
  projectId?: string;
}

export interface AuditService {
  record(e: Omit<AuditEntry, 'id' | 'ts'>): AuditEntry;
  list(filter: AuditListFilter): AuditEntry[];
}

export class DeniedError extends Error {
  readonly verdict: DenyVerdict;
  constructor(verdict: DenyVerdict) {
    super(verdict.reason ?? 'denied by deny-list');
    this.name = 'DeniedError';
    this.verdict = verdict;
  }
}

const PK_RE = /^(?:claude|codex|agnc):\S+$/;

export function sessionPkOf(target: string | null, params: Record<string, unknown>): string | null {
  if (target && PK_RE.test(target)) return target;
  const p = params.sessionPk;
  return typeof p === 'string' && PK_RE.test(p) ? p : null;
}

export function createAuditService(opts: { db: OrcDb; bus?: EventBus; now?: () => Date }): AuditService {
  const now = opts.now ?? (() => new Date());
  return {
    record(e) {
      const entry: AuditEntry = {
        id: randomUUID(),
        ts: now().toISOString(),
        actor: e.actor,
        actorDetail: e.actorDetail === null ? null : redact(e.actorDetail).slice(0, 200),
        action: e.action,
        target: e.target === null ? null : redact(e.target),
        params: redactParams(e.params),
        result: e.result,
        error: e.error === null ? null : redact(e.error).slice(0, 1000),
      };
      insertAudit(opts.db, { ...entry, sessionPk: sessionPkOf(entry.target, entry.params) });
      opts.bus?.emit({ type: 'audit.recorded', entry });
      return entry;
    },
    list(filter) {
      return queryAudit(opts.db, filter);
    },
  };
}

export async function audited<T>(
  audit: AuditService,
  meta: Omit<AuditEntry, 'id' | 'ts' | 'result' | 'error'>,
  fn: () => Promise<T>,
): Promise<T> {
  let value: T;
  try {
    value = await fn();
  } catch (err) {
    audit.record({
      ...meta,
      result: err instanceof DeniedError ? 'denied' : 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  audit.record({ ...meta, result: 'ok', error: null });
  return value;
}
