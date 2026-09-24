import type { LiveEvent } from '@orc/api-contract';
import { redactInboxItem, redactSession, redactValue } from './redact-out.ts';

/**
 * The one place a live event is redacted before it goes out on `/ws`. It uses the same
 * `redact-out.ts` helpers as the HTTP routes rather than `@orc/core`'s `redactDeep`, whose
 * key-only masking misses the `{name, value}` and argv shapes the daemon's walker catches.
 * The switch is exhaustive: a new `LiveEvent` type without a redaction decision is a compile error.
 */
export function toWireEvent(e: LiveEvent): LiveEvent {
  switch (e.type) {
    case 'session.updated':
      return { type: 'session.updated', session: redactSession(e.session) };
    case 'inbox.upserted':
      // `reason` is built from whatever made the session need attention, and `payload` is open.
      return { type: 'inbox.upserted', item: redactInboxItem(e.item) };
    case 'audit.recorded':
      // `params` can hold PTY input or a write route's body.
      return { type: 'audit.recorded', entry: redactValue(e.entry) as typeof e.entry };
    case 'usage.updated':
      return { type: 'usage.updated', snapshot: redactValue(e.snapshot) };
    // Ids, counters and a timestamp only.
    case 'session.removed':
    case 'pty.exited':
    case 'index.progress':
    case 'hello':
      return e;
    default: {
      const unhandled: never = e;
      return unhandled;
    }
  }
}
