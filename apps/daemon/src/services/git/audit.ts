import type { AuditActor } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { type AuditService, audited } from '../audit/audit.ts';

export function auditOf(ctx: DaemonContext): AuditService {
  if (!ctx.audit) throw new Error('audit service missing: Phase 3 must be wired before Phase 4 write paths');
  return ctx.audit;
}

export function runAudited<T>(
  ctx: DaemonContext,
  actor: AuditActor,
  action: string,
  target: string | null,
  params: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  return audited(auditOf(ctx), { actor, actorDetail: null, action, target, params }, fn);
}
