export type InboxKind =
  | 'waiting'
  | 'review'
  | 'plan_approval'
  | 'blocked'
  | 'error'
  | 'tests_red'
  | 'budget'
  | 'automation_result'
  | 'supervisor_escalation'
  | 'pr_event'
  | 'reminder';
export type InboxState = 'open' | 'snoozed' | 'done' | 'auto_resolved';
export interface InboxItem {
  id: string;
  kind: InboxKind;
  sessionId: string | null;
  projectId: string | null;
  ticket: string | null;
  reason: string;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  state: InboxState;
  snoozeUntil: string | null;
  payload: Record<string, unknown>;
}
