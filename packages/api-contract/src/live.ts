import type { AuditEntry, InboxItem, Session } from '@orc/core';

/** contracts §6 — WS /ws live events (the socket itself ships in Phase 2). */
export type LiveEvent =
  | { type: 'session.updated'; session: Session }
  | { type: 'session.removed'; pk: string }
  | { type: 'inbox.upserted'; item: InboxItem }
  | { type: 'pty.exited'; ptyId: string; code: number | null }
  | { type: 'index.progress'; done: number; total: number }
  | { type: 'usage.updated'; snapshot: unknown }
  | { type: 'hello'; serverTime: string }
  | { type: 'audit.recorded'; entry: AuditEntry };
