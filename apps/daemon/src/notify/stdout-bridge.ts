import { type InboxItem, type InboxKind, redact } from '@orc/core';
import type { NotifyChannelImpl } from './notifier.ts';

export const NOTIFY_PREFIX = 'ORC_NOTIFY ';

export interface NotifyLine {
  title: string;
  body: string;
  url: string;
  kind: string;
}

const TITLES: Record<InboxKind, string> = {
  waiting: 'Waiting',
  review: 'Ready for review',
  plan_approval: 'Plan awaiting approval',
  blocked: 'Blocked',
  error: 'Error',
  tests_red: 'Tests went red',
  budget: 'Budget',
  automation_result: 'Automation result',
  supervisor_escalation: 'Supervisor escalation',
  pr_event: 'Pull request',
  reminder: 'Reminder',
};

export function notifyLine(item: InboxItem, url: string): NotifyLine {
  const base = TITLES[item.kind];
  return {
    title: item.ticket ? `${base} · ${item.ticket}` : base,
    body: redact(item.reason).slice(0, 240),
    url,
    kind: item.kind,
  };
}

/**
 * Notification channel for the Tauri shell: instead of node-notifier, print one line to stdout,
 * which the Rust side turns into a native notification. Enabled with ORC_NOTIFY_BRIDGE=stdout.
 * It takes the `macos` channel id, so the notification preferences route to it unchanged.
 */
export function createStdoutNotifyChannel(
  write: (line: string) => void = (l) => void process.stdout.write(l),
): NotifyChannelImpl {
  return {
    id: 'macos',
    async send(item, url) {
      write(`${NOTIFY_PREFIX}${JSON.stringify(notifyLine(item, url))}\n`);
    },
  };
}
