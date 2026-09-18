import type { PrRef } from './session.ts';

export type GoalState = 'active' | 'paused' | 'blocked' | 'complete';
export interface Goal {
  id: string;
  targetType: 'session' | 'stream';
  targetId: string;
  objective: string;
  state: GoalState;
  blockedReason: string | null;
  updatedAt: string;
}
export interface Handoff {
  id: string;
  sessionId: string;
  status: string;
  summary: string;
  evidence: string[];
  files: string[];
  nextSteps: string[];
  blockers: string[];
  links: string[];
  createdAt: string;
}

export interface Worktree {
  path: string;
  repo: string;
  branch: string;
  base: string | null;
  ticket: string | null;
  dirty: boolean;
  prUrl: string | null;
  state: 'active' | 'archived';
  createdByApp: boolean;
}
export interface Checkpoint {
  id: string;
  sessionId: string;
  worktreePath: string;
  turn: number;
  ref: string;
  commit: string;
  createdAt: string;
}

export type StreamStage =
  | 'planned'
  | 'implementing'
  | 'in_review'
  | 'pr_open'
  | 'merged'
  | 'backmerged'
  | 'released';
export interface WorkStream {
  ticket: string;
  projectId: string;
  title: string | null;
  stage: StreamStage;
  sessionIds: string[];
  prs: PrRef[];
  plans: string[];
  worktrees: string[];
  costUsd: number;
  lastActivityAt: string;
}
