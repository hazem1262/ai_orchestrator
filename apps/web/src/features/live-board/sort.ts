import type { LiveStatus, Session, Source, TestResult } from '@orc/core';
import { shortenPath } from '@/lib/format.ts';
import type { LiveGroupBy } from '@/stores/live-layout.ts';

export const STATUS_LABEL: Record<LiveStatus, string> = {
  busy: 'Busy',
  idle: 'Idle',
  waiting: 'Waiting',
  shell: 'Shell',
  review: 'Ready for review',
  blocked: 'Blocked',
  error: 'Error',
  ended: 'Ended',
};

/** Board order (docs/02 F1): everything that needs a human first, dead sessions last. */
const RANK: Record<LiveStatus, number> = {
  waiting: 0,
  review: 1,
  blocked: 2,
  error: 3,
  busy: 4,
  shell: 5,
  idle: 6,
  ended: 7,
};

const SOURCE_LABEL: Record<Source, string> = { claude: 'Claude', codex: 'Codex', agnc: 'AGNC' };

export const attentionRank = (status: LiveStatus): number => RANK[status];

export const isAttention = (status: LiveStatus): boolean => RANK[status] <= RANK.error;

/** Attention first, and within one status the session that has been in it longest. */
export function sortLive(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const ra = RANK[a.live?.status ?? 'ended'];
    const rb = RANK[b.live?.status ?? 'ended'];
    if (ra !== rb) return ra - rb;
    return (a.live?.since ?? '').localeCompare(b.live?.since ?? '');
  });
}

export function filterByProject(sessions: Session[], projectId?: string): Session[] {
  return projectId ? sessions.filter((s) => s.projectId === projectId) : sessions;
}

export interface LiveGroup {
  key: string;
  label: string;
  sessions: Session[];
}

export function groupLive(sessions: Session[], by: LiveGroupBy): LiveGroup[] {
  if (by === 'none') return [{ key: 'all', label: 'All sessions', sessions }];
  const groups = new Map<string, LiveGroup>();
  for (const s of sessions) {
    const [key, label] =
      by === 'project'
        ? [s.projectId ?? '_none', s.projectId ?? 'No project']
        : by === 'ticket'
          ? [s.tickets[0] ?? '_none', s.tickets[0] ?? 'No ticket']
          : [s.source, SOURCE_LABEL[s.source]];
    const g = groups.get(key) ?? { key, label, sessions: [] };
    g.sessions.push(s);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Time in state, compact enough for a card header. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export type PermissionBadge = 'bypass' | 'plan' | 'auto' | 'default' | 'custom';

export function permissionBadge(mode: string | null): PermissionBadge | null {
  if (!mode) return null;
  if (mode === 'bypassPermissions') return 'bypass';
  if (mode === 'plan') return 'plan';
  if (mode === 'acceptEdits' || mode === 'auto') return 'auto';
  if (mode === 'default') return 'default';
  return 'custom';
}

/** True when the agent has moved out of the directory it was resumed in. */
export function hasDrift(s: Session): boolean {
  const last = s.cwds.at(-1);
  return last !== undefined && last !== s.startCwd;
}

export function shortPath(p: string): string {
  const parts = shortenPath(p).split('/');
  return parts.length > 5 ? [parts[0], '…', ...parts.slice(-3)].join('/') : parts.join('/');
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function resumeCommand(s: Session): string {
  const cmd = s.source === 'codex' ? `codex resume ${s.id}` : `claude --resume ${s.id}`;
  return `cd ${shq(s.startCwd)} && ${cmd}`;
}

export function testChipText(t: TestResult): string {
  return `✓ ${t.passed} · ✗ ${t.failed}`;
}
