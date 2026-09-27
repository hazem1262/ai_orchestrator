import type { GoalState } from '@orc/core';

export const GOAL_STATES: ReadonlyArray<{ id: GoalState; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'paused', label: 'Paused' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'complete', label: 'Complete' },
];

export function goalBadgeTone(state: GoalState): 'ok' | 'warn' | 'muted' | 'done' {
  if (state === 'blocked') return 'warn';
  if (state === 'complete') return 'done';
  return state === 'paused' ? 'muted' : 'ok';
}
