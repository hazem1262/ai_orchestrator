export type AnalyticsGroupBy = 'day' | 'week' | 'project' | 'model' | 'source' | 'ticket';
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface CostRow {
  key: string;
  costUsd: number;
  tokens: TokenTotals;
  sessions: number;
}
export interface TopSession {
  pk: string;
  name: string | null;
  projectId: string | null;
  costUsd: number;
  tickets: string[];
}
export interface TopTicket {
  ticket: string;
  costUsd: number;
  sessions: number;
}
export interface TopResult {
  sessions: TopSession[];
  tickets: TopTicket[];
  mergedPrs: number;
  costPerMergedPrUsd: number | null;
}
export type ToolKind = 'tool' | 'mcp' | 'skill';
export interface ToolUsageRow {
  bucket: string;
  kind: ToolKind;
  name: string;
  count: number;
}
export interface TimingResult {
  modelMs: number;
  toolMs: number;
  modelShare: number | null;
  cacheHitTrend: Array<{ bucket: string; rate: number | null }>;
}
export interface OutcomesResult {
  sessions: number;
  outcomes: Record<string, number>;
  friction: Record<string, number>;
  goalCategories: Record<string, number>;
}
export interface WstackSkillRow {
  skill: string;
  runs: number;
  outcomes: Record<string, number>;
  avgDurationS: number | null;
}
