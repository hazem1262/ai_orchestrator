export type SessionMetaType =
  | 'agent-name'
  | 'ai-title'
  | 'last-prompt'
  | 'permission-mode'
  | 'mode'
  | 'pr-link'
  | 'bridge-session'
  | 'frame-link'
  | 'cost-state'
  | 'summary'
  | 'custom-title';

export interface ClaudeMessageRecord {
  type: string;
  uuid: string;
  parentUuid: string | null;
  isSidechain?: boolean;
  sessionId: string;
  agentId?: string;
  timestamp: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  toolUseResult?: unknown;
  attributionSkill?: string;
  apiBlockIndex?: number;
  subtype?: string;
  durationMs?: number;
  content?: unknown;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
}

export type ClaudeRecordClass =
  | { kind: 'human_prompt'; rec: ClaudeMessageRecord; text: string }
  | { kind: 'tool_result'; rec: ClaudeMessageRecord }
  | { kind: 'meta'; rec: ClaudeMessageRecord }
  | { kind: 'assistant'; rec: ClaudeMessageRecord }
  | { kind: 'system'; rec: ClaudeMessageRecord; subtype: string | null }
  | { kind: 'attachment'; rec: ClaudeMessageRecord }
  | { kind: 'session_meta'; type: SessionMetaType; rec: Record<string, unknown> }
  | { kind: 'ignored'; type: string }
  | { kind: 'unknown'; type: string | null };

const SESSION_META = new Set<string>([
  'agent-name',
  'ai-title',
  'last-prompt',
  'permission-mode',
  'mode',
  'pr-link',
  'bridge-session',
  'frame-link',
  'cost-state',
  'summary',
  'custom-title',
]);
const IGNORED = new Set<string>([
  'queue-operation',
  'file-history-snapshot',
  'file-history-delta',
  'atis-latch',
]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: 'text'; text: string } => isObj(b) && b.type === 'text' && typeof b.text === 'string',
    )
    .map((b) => b.text)
    .join('\n');
}

function hasToolResultBlock(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => isObj(b) && b.type === 'tool_result');
}

export function classifyClaudeRecord(value: unknown): ClaudeRecordClass {
  if (!isObj(value)) return { kind: 'unknown', type: null };
  const type = typeof value.type === 'string' ? value.type : null;
  if (type === null) return { kind: 'unknown', type: null };
  if (SESSION_META.has(type)) return { kind: 'session_meta', type: type as SessionMetaType, rec: value };
  if (IGNORED.has(type) || type.startsWith('artifact-')) return { kind: 'ignored', type };

  const rec = value as unknown as ClaudeMessageRecord;
  switch (type) {
    case 'user': {
      if (rec.toolUseResult !== undefined || hasToolResultBlock(rec.message?.content))
        return { kind: 'tool_result', rec };
      if (rec.isMeta === true) return { kind: 'meta', rec };
      return { kind: 'human_prompt', rec, text: contentText(rec.message?.content) };
    }
    case 'assistant':
      return { kind: 'assistant', rec };
    case 'system':
      return { kind: 'system', rec, subtype: typeof rec.subtype === 'string' ? rec.subtype : null };
    case 'attachment':
      return { kind: 'attachment', rec };
    default:
      return { kind: 'unknown', type };
  }
}
