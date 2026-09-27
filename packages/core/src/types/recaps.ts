export type RecapKind = 'session' | 'daily' | 'handoff';
export type RecapEngineId = 'claude-cli' | 'anthropic-api';

export interface Recap {
  id: string;
  kind: RecapKind;
  targetKey: string;
  transcriptOffset: number;
  model: string;
  engine: RecapEngineId;
  text: string;
  costUsd: number;
  inputTokensApprox: number;
  createdAt: string;
}

export type ReminderState = 'pending' | 'fired' | 'cancelled';

export interface Reminder {
  id: string;
  jobId: string;
  sessionPk: string | null;
  ticket: string | null;
  text: string;
  dueAt: string;
  sendToSession: boolean;
  state: ReminderState;
  createdAt: string;
  firedAt: string | null;
}

export interface DigestRecord {
  weekStart: string;
  markdown: string;
  createdAt: string;
}
