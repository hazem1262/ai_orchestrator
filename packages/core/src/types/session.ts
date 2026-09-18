export type Source = 'claude' | 'codex' | 'agnc';
export type Availability = 'resumable' | 'archived' | 'prompts-only' | 'remote';
export type LiveStatus = 'busy' | 'idle' | 'waiting' | 'shell' | 'review' | 'blocked' | 'error' | 'ended';
export type Stage = 'understand' | 'modify' | 'test' | 'review';
export type Ownership = 'observed' | 'owned';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null });

export interface PrRef {
  repo: string;
  number: number;
  url: string;
}

export interface TestResult {
  ts: string;
  command: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
}

export interface Session {
  id: string; // source-native id (Claude sessionId / Codex session id / AGNC id)
  source: Source;
  projectId: string | null; // resolved via project path prefixes
  startCwd: string; // resume dir
  cwds: string[]; // distinct cwds in first-seen order (startCwd first)
  name: string | null; // agent-name → ai-title → first prompt (truncated 80)
  firstPrompt: string | null;
  lastPrompt: string | null;
  awaySummary: string | null;
  recap: string | null; // LLM recap (F14)
  startedAt: string; // ISO
  lastActivityAt: string; // ISO
  models: string[]; // excludes '<synthetic>'
  permissionMode: string | null;
  usage: Usage;
  linesAdded: number | null;
  linesRemoved: number | null;
  prs: PrRef[];
  tickets: string[];
  skills: string[];
  mcpServers: string[];
  filesTouched: string[];
  promptCount: number;
  toolCallCount: number;
  apiErrorCount: number;
  flags: { touchedProd: boolean; hasSubagents: boolean; automated: boolean };
  availability: Availability;
  transcriptPath: string | null;
  lastTest: TestResult | null;
  live: LiveState | null;
}

export interface LiveState {
  pid: number | null;
  status: LiveStatus;
  waitingFor: string | null;
  since: string; // ISO, when status last changed
  ownership: Ownership;
  ptyId: string | null; // set when owned
  stage: Stage | null;
  currentTool: string | null;
  backgroundJobs: number;
  runningSubagents: number;
  contextFill: number | null; // 0..1
}

export interface AgentNode {
  id: string; // agentId
  sessionId: string;
  parentId: string | null; // parent agentId, null = main session
  depth: number;
  agentType: string;
  description: string;
  background: boolean;
  toolUseId: string | null;
  usage: Usage;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'done' | 'error';
  transcriptPath: string;
}

export interface Project {
  id: string;
  name: string;
  pathPrefixes: string[];
  hidden: boolean;
  lastActivityAt: string | null;
  sessionCount: number;
}
