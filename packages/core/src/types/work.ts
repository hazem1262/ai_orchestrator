import type { PrRef, TestResult } from './session.ts';

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

export type WorktreeOrigin =
  | 'app'
  | 'config'
  | 'session-cwd'
  | 'claude-json'
  | 'worktree-dir'
  | 'sibling'
  | 'scratchpad';

export interface PrStatus {
  pr: PrRef;
  state: 'open' | 'closed' | 'merged';
  title: string;
  checks: 'pending' | 'success' | 'failure' | 'none';
  review: 'approved' | 'changes_requested' | 'review_required' | 'none';
  updatedAt: string;
  headRef: string | null;
  failedChecks: string[];
}

export interface WorktreeView extends Worktree {
  head: string | null;
  isMain: boolean;
  origin: WorktreeOrigin;
  sessionPks: string[];
  projectId: string | null;
  prStatus: PrStatus | null;
  updatedAt: string;
}

export interface CheckpointRecord extends Checkpoint {
  kind: 'turn' | 'safety' | 'manual';
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffFileEntry {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';
  additions: number;
  deletions: number;
  patch: string;
  hunks: DiffHunk[];
}

export interface DiffResult {
  cwd: string;
  from: string;
  to: string;
  files: DiffFileEntry[];
  additions: number;
  deletions: number;
}

export interface ReviewComment {
  file: string;
  line: number;
  side: 'old' | 'new';
  body: string;
}

export interface ReviewSummary {
  sessionPk: string;
  cwd: string;
  worktree: WorktreeView | null;
  files: Array<{ path: string; additions: number; deletions: number }>;
  additions: number;
  deletions: number;
  lastTest: TestResult | null;
  recap: string | null;
  pr: PrStatus | null;
  owned: boolean;
  checkpoints: CheckpointRecord[];
}
