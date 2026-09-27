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
      // Timestamps and numbers today; the walker keeps numeric token counts and masks any string.
      return { type: 'usage.updated', snapshot: redactValue(e.snapshot) as typeof e.snapshot };
    // Paths, branch names, tickets, PR titles and URLs: all can carry text a user or agent wrote.
    case 'worktree.updated':
      return { type: 'worktree.updated', worktree: redactValue(e.worktree) as typeof e.worktree };
    case 'worktree.removed':
      return { type: 'worktree.removed', path: redactValue(e.path) as string };
    case 'pr.updated':
      return { type: 'pr.updated', status: redactValue(e.status) as typeof e.status };
    case 'checkpoint.created':
      return { type: 'checkpoint.created', checkpoint: redactValue(e.checkpoint) as typeof e.checkpoint };
    // `summary`, `error` and `vars` carry agent output and trigger text.
    case 'automation.runUpdated':
      return { type: 'automation.runUpdated', run: redactValue(e.run) as typeof e.run };
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
