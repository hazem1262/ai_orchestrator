import type { PrRef } from './session.ts';
import type { BudgetCheck } from './usage.ts';
import type { Goal, Handoff, WorkStream } from './work.ts';

export type StreamLinkKind = 'session' | 'pr' | 'plan' | 'worktree' | 'workflow';

export interface StreamLink {
  ticket: string;
  kind: StreamLinkKind;
  ref: string;
  origin: 'auto' | 'manual';
  excluded: boolean;
  createdAt: string;
}

export type TicketSignalSource =
  | 'session_tickets'
  | 'prompt'
  | 'branch'
  | 'pr_title'
  | 'pr_body'
  | 'plan_file'
  | 'wstack_workflow'
  | 'worktree'
  | 'manual';

export interface TicketSignal {
  ticket: string;
  kind: StreamLinkKind;
  ref: string;
  source: TicketSignalSource;
}

export interface StreamPr {
  pr: PrRef;
  title: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string | null;
  baseRef: string | null;
  isBackmerge: boolean;
  checks: 'pending' | 'success' | 'failure' | 'none';
  review: 'approved' | 'changes_requested' | 'review_required' | 'none';
  updatedAt: string;
  mergedAt: string | null;
}

export type StreamTimelineKind =
  | 'session'
  | 'pr'
  | 'plan'
  | 'worktree'
  | 'recap'
  | 'handoff'
  | 'goal'
  | 'workflow';

export interface StreamTimelineItem {
  ts: string;
  kind: StreamTimelineKind;
  title: string;
  ref: string;
  detail: string | null;
}

export interface StreamDetail {
  stream: WorkStream;
  prsDetailed: StreamPr[];
  links: StreamLink[];
  timeline: StreamTimelineItem[];
  goal: Goal | null;
  handoff: Handoff | null;
  budget: BudgetCheck;
}
