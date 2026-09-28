import type { InboxItem, InboxKind, Source } from '@orc/core';
import {
  AlarmClock,
  Bot,
  CircleAlert,
  CircleDollarSign,
  ClipboardCheck,
  Eye,
  FlaskConicalOff,
  GitPullRequest,
  Hand,
  KeyRound,
  type LucideIcon,
  OctagonX,
  ShieldAlert,
} from 'lucide-react';

export const KIND_LABEL: Record<InboxKind, string> = {
  waiting: 'Waiting',
  review: 'Ready for review',
  plan_approval: 'Plan approval',
  blocked: 'Blocked',
  error: 'Error',
  tests_red: 'Tests red',
  budget: 'Budget',
  automation_result: 'Automation',
  supervisor_escalation: 'Supervisor',
  pr_event: 'Pull request',
  reminder: 'Reminder',
};

const KIND_ICON: Record<InboxKind, LucideIcon> = {
  waiting: Hand,
  review: Eye,
  plan_approval: ClipboardCheck,
  blocked: CircleAlert,
  error: OctagonX,
  tests_red: FlaskConicalOff,
  budget: CircleDollarSign,
  automation_result: Bot,
  supervisor_escalation: ShieldAlert,
  pr_event: GitPullRequest,
  reminder: AlarmClock,
};

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const KIND_TONE: Record<InboxKind, Tone> = {
  waiting: 'warning',
  review: 'success',
  plan_approval: 'info',
  blocked: 'warning',
  error: 'danger',
  tests_red: 'danger',
  budget: 'warning',
  automation_result: 'neutral',
  supervisor_escalation: 'danger',
  pr_event: 'info',
  reminder: 'neutral',
};

/** Soft badge fills over the semantic status tokens in index.css. */
export const SOFT_TONE: Record<Tone, string> = {
  neutral: 'bg-secondary text-secondary-foreground',
  info: 'bg-info/15 text-info',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
};

/** A `waiting` item with a tool in its payload is a permission prompt, and gets its own label. */
export function kindMeta(item: InboxItem): { label: string; icon: LucideIcon; tone: Tone } {
  const permission = item.kind === 'waiting' && typeof item.payload.tool === 'string';
  const failedPr = item.kind === 'pr_event' && /failed/i.test(item.reason);
  return {
    label: permission ? 'Permission' : KIND_LABEL[item.kind],
    icon: permission ? KeyRound : KIND_ICON[item.kind],
    tone: failedPr ? 'danger' : KIND_TONE[item.kind],
  };
}

/** The session an item points at, when its payload carries one (contracts §9). */
export function sessionRef(item: InboxItem): { source: Source; id: string } | null {
  const { source, id } = item.payload;
  return typeof source === 'string' && typeof id === 'string' ? { source: source as Source, id } : null;
}

export const isTriageable = (item: InboxItem) => item.state === 'open' || item.state === 'snoozed';

/**
 * The kinds `POST /api/inbox/:id/approve` accepts: the route in apps/daemon/src/http/routes/session-actions.ts
 * calls `approve()` in apps/daemon/src/services/remote/session-actions.ts, which answers 409
 * `not_approvable` for every other kind.
 */
export const APPROVABLE_KINDS: ReadonlySet<InboxKind> = new Set<InboxKind>([
  'plan_approval',
  'automation_result',
]);

/**
 * Whether a row offers the one-click Approve. A plan approval is answered from its expanded panel
 * ("Approve plan", with a confirm step) instead.
 */
export const offersApprove = (item: InboxItem) =>
  isTriageable(item) && APPROVABLE_KINDS.has(item.kind) && item.kind !== 'plan_approval';

/** Kinds with a panel of their own (plan text, PR links) under the row. */
export const hasDetail = (item: InboxItem) =>
  isTriageable(item) && (item.kind === 'plan_approval' || item.kind === 'pr_event');

/** One inbox row: an item, plus any others with the same kind, reason and ticket. */
export interface InboxGroup {
  key: string;
  /** The newest member; the row shows its details and kind panel. */
  lead: InboxItem;
  items: InboxItem[];
}

/**
 * Collapses items that read the same — one PR notice raised by four sessions, say — into one row.
 * Order follows each group's first appearance, so a newest-first list stays newest-first.
 */
export function groupItems(items: InboxItem[]): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  for (const item of items) {
    const key = JSON.stringify([item.kind, item.reason, item.ticket ?? null]);
    const g = groups.get(key);
    if (g) g.items.push(item);
    else groups.set(key, { key, lead: item, items: [item] });
  }
  return [...groups.values()];
}
