import type { LiveEvent } from '@orc/api-contract';
import type { LiveStatus, TestResult } from '@orc/core';

/** contracts §6 (LiveEvent) + daemon-internal events (session.indexed etc.). */
export type BusEvent =
  | LiveEvent
  | { type: 'hook.received'; payload: unknown }
  | { type: 'session.statusChanged'; pk: string; from: LiveStatus | null; to: LiveStatus }
  | { type: 'session.turnEnded'; pk: string; turn: number }
  | { type: 'tests.recorded'; pk: string; result: TestResult }
  | { type: 'session.indexed'; pk: string };

export interface EventBus {
  emit(e: BusEvent): void;
  on<T extends BusEvent['type']>(type: T, fn: (e: Extract<BusEvent, { type: T }>) => void): () => void;
}

type Handler = (e: BusEvent) => void;

/**
 * Minimal typed pub/sub for the daemon process. A throwing handler is isolated (logged via
 * `onError`, or to console.error by default) and never prevents sibling handlers from running.
 */
export function createEventBus(opts: { onError?: (err: unknown, e: BusEvent) => void } = {}): EventBus {
  const handlers = new Map<BusEvent['type'], Set<Handler>>();
  const onError =
    opts.onError ??
    ((err: unknown, e: BusEvent) => console.error(`event bus handler failed for ${e.type}`, err));

  return {
    emit(e) {
      const set = handlers.get(e.type);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(e);
        } catch (err) {
          onError(err, e);
        }
      }
    },
    on(type, fn) {
      const set = handlers.get(type) ?? new Set<Handler>();
      handlers.set(type, set);
      const h = fn as Handler;
      set.add(h);
      return () => {
        set.delete(h);
      };
    },
  };
}
