import type { ArchiveStatus } from '@orc/api-contract';
import type { InboxKind } from '@orc/core';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function daysAgo(iso: string, now: number): number {
  return Math.floor((now - Date.parse(iso)) / 86_400_000);
}

/** Claude prunes `~/.claude/projects` on its own schedule; anything under 90 days is worth a
 *  warning because the archive is the only copy that outlives it. */
export function retentionWarning(s: Pick<ArchiveStatus, 'cleanupPeriodDays' | 'enabled'>): string | null {
  if (!s.enabled) return "Archive is off — transcripts older than Claude's cleanup period will be lost.";
  if (s.cleanupPeriodDays === null) {
    return 'Claude deletes transcripts after 30 days (default). Keep the archive on, or raise cleanupPeriodDays.';
  }
  if (s.cleanupPeriodDays < 90) {
    return `Claude deletes transcripts after ${s.cleanupPeriodDays} days. Keep the archive on, or raise cleanupPeriodDays.`;
  }
  return null;
}

export const NOTIFY_KINDS: ReadonlyArray<{ kind: InboxKind; label: string }> = [
  { kind: 'waiting', label: 'Waiting for input' },
  { kind: 'review', label: 'Ready for review' },
  { kind: 'plan_approval', label: 'Plan awaiting approval' },
  { kind: 'blocked', label: 'Blocked' },
  { kind: 'error', label: 'Error / API failure' },
  { kind: 'tests_red', label: 'Tests went red' },
  { kind: 'budget', label: 'Over budget / near quota' },
  { kind: 'automation_result', label: 'Automation result' },
  { kind: 'supervisor_escalation', label: 'Supervisor escalation' },
  { kind: 'pr_event', label: 'PR check failed / review requested' },
  { kind: 'reminder', label: 'Reminder' },
];

const hookCmd =
  'curl -s -m 2 -X POST -H \\"x-orc-token: $(cat ~/.orchestrator/token)\\" -H \'content-type: application/json\' --data-binary @- http://127.0.0.1:4317/api/hooks >/dev/null || true';
const hookEntry = `[{ "hooks": [{ "type": "command", "command": "${hookCmd}" }] }]`;
export const HOOK_SNIPPET = `{
  "hooks": {
    "Notification": ${hookEntry},
    "Stop": ${hookEntry},
    "UserPromptSubmit": ${hookEntry}
  }
}`;
