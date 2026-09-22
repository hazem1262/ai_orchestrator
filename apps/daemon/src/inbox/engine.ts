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
 * `snooze(until)` accepts only a fully-qualified ISO instant with a four-digit year and an
 * explicit zone. Two things ride on this beyond tidiness:
 *   - `'2026-09-01T20:00:00'` (no zone) is parsed as *local* time, so the same request would
 *     snooze for a different length of time depending on where the daemon runs.
 *   - `snoozeUntil` is compared lexicographically in SQL (`listDueSnoozed`). An expanded-year
 *     timestamp (`'+010000-01-01T…'`) starts with `'+'`, which sorts before every digit, so a
 *     snooze a thousand years out would come due on the very next tick. A four-digit year cannot
 *     round-trip through `toISOString()` into the expanded form, so the format check closes it.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

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

/**
 * The payload is persisted with `JSON.stringify`, which *throws* on a cycle or a `BigInt`. A rule
 * that builds one would throw out of `upsert`, and `registerRule`'s isolation would catch it and
 * log `inbox rule failed` — so the item would never appear, with no error the user can see. That
 * is the silent-suppression failure this component exists to prevent, arriving by the back door.
 *
 * So serialization is checked here, per key: whatever survives is kept, the rest is dropped, and
 * the item is flagged. A degraded payload beats no item at all.
 */
function safePayload(payload: Record<string, unknown>): Record<string, unknown> {
  try {
    JSON.stringify(payload);
    return payload;
  } catch {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      try {
        JSON.stringify(v);
        out[k] = v;
      } catch {
        // this one key is the problem; drop it and keep the rest
      }
    }
    out.serializationFailed = true; // set last: it must win over a key of the same name
    return out;
  }
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
        //
        // Field semantics, uniform across the four mutable columns: `undefined` (or absent)
        // leaves the stored value alone, any other value — including `null` — replaces it. The
        // `?? existing.x` form this replaced could only ever *set* a field, so a rule could never
        // clear a ticket it had stopped being able to derive, and `sessionId` was ignored outright.
        const updated = updateInboxItem(ctx.db, existing.id, {
          reason,
          updatedAt: ts,
          ...(u.payload !== undefined ? { payload: safePayload(u.payload) } : {}),
          ...(u.ticket !== undefined ? { ticket: u.ticket } : {}),
          ...(u.projectId !== undefined ? { projectId: u.projectId } : {}),
          ...(u.sessionId !== undefined ? { sessionId: u.sessionId } : {}),
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
        payload: u.payload === undefined ? {} : safePayload(u.payload),
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
      if (!ISO_INSTANT.test(until) || !Number.isFinite(untilMs) || untilMs <= clock().getTime()) {
        throw new InboxError(
          400,
          'validation_failed',
          'snooze "until" must be a future ISO instant with a four-digit year and an explicit zone',
        );
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
