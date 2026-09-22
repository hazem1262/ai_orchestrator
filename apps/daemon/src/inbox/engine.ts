import { randomUUID } from 'node:crypto';
import { type InboxItem, type InboxKind, type InboxState, redact, truncate } from '@orc/core';
import type { DaemonContext } from '../context.ts';
import {
  findActiveByDedupe,
  getInboxItem,
  insertInboxItem,
  listDueSnoozed,
  listInboxItems,
  updateInboxItem,
} from '../db/repos/inbox.ts';
import type { BusEvent } from '../live/event-bus.ts';
import type { Notifier } from '../notify/notifier.ts';
import { type InboxKey, inboxDedupeKey } from './dedupe-key.ts';

export type { InboxKey, InboxScope } from './dedupe-key.ts';
export { inboxDedupeKey } from './dedupe-key.ts';

/** How long a `reason` may be once it has been redacted. */
export const REASON_MAX = 300;

/**
 * contracts §11. Note what is *absent*: there is no `dedupeKey`. A caller says what the item is
 * (`kind`) and what it is about (`scope`, `facet`); the engine composes the key. See
 * `dedupe-key.ts` for why a caller-supplied key is a silent-suppression bug waiting to happen.
 */
export interface InboxUpsert extends InboxKey {
  sessionId?: string | null;
  projectId?: string | null;
  ticket?: string | null;
  reason: string;
  payload?: Record<string, unknown>;
}

export interface InboxRule {
  name: string;
  on: BusEvent['type'][];
  handle(e: BusEvent, ctx: DaemonContext): void;
}

export interface InboxEngine {
  upsert(item: InboxUpsert): InboxItem;
  resolve(key: InboxKey): void;
  list(filter: { state?: InboxState[]; kind?: InboxKind[]; projectId?: string }): InboxItem[];
  markDone(id: string): InboxItem;
  snooze(id: string, until: string): InboxItem;
  reopen(id: string): InboxItem;
  registerRule(rule: InboxRule): void;
}

export interface InboxEngineRuntime extends InboxEngine {
  tick(now?: Date): void;
  start(intervalMs?: number): void;
  stop(): void;
}

export class InboxError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: 'not_found' | 'validation_failed',
    message: string,
  ) {
    super(message);
    this.name = 'InboxError';
  }
}

const ACTIVE = new Set<InboxState>(['open', 'snoozed']);

/**
 * Redact **then** truncate — never the other way round. Phase 1 shipped the inverse as a Critical:
 * cutting first turns `PGPASSWORD=hunter2` into `SSWORD=hunter2`, which no pattern matches any
 * more because the anchor went with the prefix. Truncating an already-redacted string is safe.
 * `truncate` (core) is used rather than `slice` because it will not split a UTF-16 surrogate pair.
 */
function cleanReason(raw: string): string {
  return truncate(redact(raw), REASON_MAX);
}

export function createInboxEngine(
  ctx: DaemonContext,
  opts: { now?: () => Date; notifier?: Notifier } = {},
): InboxEngineRuntime {
  const clock = opts.now ?? (() => new Date());
  const nowIso = () => clock().toISOString();
  const unsubs: Array<() => void> = [];
  let timer: NodeJS.Timeout | null = null;

  const emit = (item: InboxItem) => ctx.bus.emit({ type: 'inbox.upserted', item });
  const fire = (item: InboxItem) => {
    const n = opts.notifier ?? ctx.notifier;
    if (!n) return;
    n.notify(item).catch((err: unknown) =>
      ctx.log.warn({ err: String(err), kind: item.kind }, 'notification failed'),
    );
  };
  const mustGet = (id: string): InboxItem => {
    const it = getInboxItem(ctx.db, id);
    if (!it) throw new InboxError(404, 'not_found', `inbox item ${id} not found`);
    return it;
  };

  const engine: InboxEngineRuntime = {
    upsert(u) {
      const ts = nowIso();
      const reason = cleanReason(u.reason);
      const dedupeKey = inboxDedupeKey(u);
      const existing = findActiveByDedupe(ctx.db, dedupeKey);
      if (existing) {
        // A refresh keeps the state — a snoozed item stays snoozed rather than nagging again —
        // and deliberately does not notify. One notification per state change; a *change* of
        // state resolves this key and opens a new item under the next one.
        const updated = updateInboxItem(ctx.db, existing.id, {
          reason,
          payload: u.payload ?? existing.payload,
          ticket: u.ticket ?? existing.ticket,
          projectId: u.projectId ?? existing.projectId,
          updatedAt: ts,
        });
        emit(updated);
        return updated;
      }
      const item: InboxItem = {
        id: randomUUID(),
        kind: u.kind,
        sessionId: u.sessionId ?? null,
        projectId: u.projectId ?? null,
        ticket: u.ticket ?? null,
        reason,
        dedupeKey,
        createdAt: ts,
        updatedAt: ts,
        state: 'open',
        snoozeUntil: null,
        payload: u.payload ?? {},
      };
      insertInboxItem(ctx.db, item);
      emit(item);
      fire(item);
      return item;
    },

    resolve(key) {
      const existing = findActiveByDedupe(ctx.db, inboxDedupeKey(key));
      if (!existing) return;
      emit(
        updateInboxItem(ctx.db, existing.id, {
          state: 'auto_resolved',
          snoozeUntil: null,
          updatedAt: nowIso(),
        }),
      );
    },

    list: (filter) => listInboxItems(ctx.db, filter),

    markDone(id) {
      mustGet(id);
      const out = updateInboxItem(ctx.db, id, { state: 'done', snoozeUntil: null, updatedAt: nowIso() });
      emit(out);
      return out;
    },

    snooze(id, until) {
      const it = mustGet(id);
      const untilMs = Date.parse(until);
      if (!Number.isFinite(untilMs) || untilMs <= clock().getTime()) {
        throw new InboxError(400, 'validation_failed', 'snooze "until" must be a future ISO timestamp');
      }
      if (!ACTIVE.has(it.state)) throw new InboxError(400, 'validation_failed', 'item is not active');
      const out = updateInboxItem(ctx.db, id, {
        state: 'snoozed',
        snoozeUntil: new Date(untilMs).toISOString(),
        updatedAt: nowIso(),
      });
      emit(out);
      return out;
    },

    reopen(id) {
      const it = mustGet(id);
      if (it.state === 'open') return it;
      // The unique index allows one active row per key. If the key was already re-raised while
      // this one sat in `done`, hand back the live item rather than letting the insert fail.
      const active = findActiveByDedupe(ctx.db, it.dedupeKey);
      if (active && active.id !== id) return active;
      const out = updateInboxItem(ctx.db, id, { state: 'open', snoozeUntil: null, updatedAt: nowIso() });
      emit(out);
      return out;
    },

    registerRule(rule) {
      for (const type of rule.on) {
        unsubs.push(
          ctx.bus.on(type, (e) => {
            try {
              rule.handle(e, ctx);
            } catch (err) {
              ctx.log.error({ err: String(err), rule: rule.name, event: type }, 'inbox rule failed');
            }
          }),
        );
      }
    },

    tick(at) {
      const now = at ?? clock();
      const iso = now.toISOString();
      for (const due of listDueSnoozed(ctx.db, iso)) {
        const out = updateInboxItem(ctx.db, due.id, { state: 'open', snoozeUntil: null, updatedAt: iso });
        emit(out);
        fire(out);
      }
    },

    start(intervalMs = 15_000) {
      engine.tick();
      timer = setInterval(() => engine.tick(), intervalMs);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const u of unsubs.splice(0)) u();
    },
  };
  return engine;
}
