import { type InboxKind, type LiveStatus, type Session, splitPk } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { previousTestResult } from '../../db/repos/test-results.ts';
import { inboxDedupeKey } from '../dedupe-key.ts';
import type { InboxEngine, InboxRule } from '../engine.ts';

export const STATUS_KIND: Partial<Record<LiveStatus, InboxKind>> = {
  waiting: 'waiting',
  review: 'review',
  error: 'error',
};

interface SessionInfo {
  s: Session | null;
  source: string;
  id: string;
  label: string;
}

/**
 * `splitPk` throws on a malformed pk. A throw here would be caught by the engine's rule isolation
 * and logged, and the item would never appear — so a malformed pk degrades to the raw pk as the
 * id instead of suppressing the item.
 */
function lookup(ctx: DaemonContext, pk: string): SessionInfo {
  let source = '';
  let id = pk;
  try {
    ({ source, id } = splitPk(pk));
  } catch {
    // keep the raw pk as the id
  }
  const s = ctx.live?.get(pk) ?? ctx.sessions.getByPk(pk);
  return { s, source, id, label: s?.name ?? id };
}

/** The engine redacts and then truncates `reason`; rules hand it the full text. */
function reasonFor(kind: InboxKind, label: string, s: Session | null): string {
  switch (kind) {
    case 'waiting':
      return `${label}: waiting — ${s?.live?.waitingFor ?? 'input needed'}`;
    case 'review': {
      const t = s?.lastTest;
      return `${label}: ready for review${t ? ` (tests ✓${t.passed} ✗${t.failed})` : ''}`;
    }
    case 'error':
      return `${label}: API error or crash`;
    default:
      return `${label}: ${kind}`;
  }
}

export const statusRule: InboxRule = {
  name: 'status',
  on: ['session.statusChanged'],
  handle(e, ctx) {
    if (e.type !== 'session.statusChanged' || !ctx.inbox) return;
    const scope = { session: e.pk };
    const fromKind = e.from ? STATUS_KIND[e.from] : undefined;
    const toKind = STATUS_KIND[e.to];
    // Work that is ready for review still needs the user after the process exits.
    const keepReviewAfterExit = fromKind === 'review' && e.to === 'ended';
    if (fromKind && fromKind !== toKind && !keepReviewAfterExit) ctx.inbox.resolve({ kind: fromKind, scope });
    if (!toKind) return;
    const { s, source, id, label } = lookup(ctx, e.pk);
    ctx.inbox.upsert({
      kind: toKind,
      scope,
      sessionId: id,
      projectId: s?.projectId ?? null,
      ticket: s?.tickets[0] ?? null,
      reason: reasonFor(toKind, label, s),
      payload: { source, id, status: e.to },
    });
  },
};

export const testsRedRule: InboxRule = {
  name: 'tests_red',
  on: ['tests.recorded'],
  handle(e, ctx) {
    if (e.type !== 'tests.recorded' || !ctx.inbox) return;
    const key = { kind: 'tests_red', scope: { session: e.pk } } as const;
    if (e.result.failed === 0) {
      ctx.inbox.resolve(key);
      return;
    }
    const prev = previousTestResult(ctx.db, e.pk, e.result.ts);
    const composed = inboxDedupeKey(key);
    const alreadyRed = ctx.inbox
      .list({ state: ['open', 'snoozed'], kind: ['tests_red'] })
      .some((i) => i.dedupeKey === composed);
    // Only a pass → fail change opens an item; fail → fail refreshes one that is already active.
    if (!alreadyRed && (!prev || prev.failed > 0)) return;
    const { s, source, id, label } = lookup(ctx, e.pk);
    ctx.inbox.upsert({
      ...key,
      sessionId: id,
      projectId: s?.projectId ?? null,
      ticket: s?.tickets[0] ?? null,
      reason: `${label}: tests went red (✗${e.result.failed} · ✓${e.result.passed})`,
      payload: { source, id, command: e.result.command, previous: prev },
    });
  },
};

export function registerDefaultRules(engine: InboxEngine): void {
  engine.registerRule(statusRule);
  engine.registerRule(testsRedRule);
}
