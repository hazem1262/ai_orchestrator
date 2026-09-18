import type { Usage } from './session.ts';

export type EventKind =
  | 'prompt'
  | 'assistant_text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'error';
export interface TimelineEvent {
  sessionId: string;
  agentId: string | null;
  uuid: string;
  parentUuid: string | null;
  seq: number; // monotonically increasing per file
  ts: string;
  kind: EventKind;
  turn: number; // increments at each human prompt
  text: string | null; // redacted at display time, stored raw
  tool: string | null; // e.g. 'Bash', 'mcp__claude_ai_Linear__save_issue'
  toolUseId: string | null;
  mcpServer: string | null;
  input: unknown | null; // tool_use input (JSON)
  messageId: string | null; // assistant message.id for usage dedupe
  model: string | null;
  usage: Usage | null; // only on the first record per messageId
  durationMs: number | null; // system turn_duration
}
