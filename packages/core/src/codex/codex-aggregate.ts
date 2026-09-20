import type { DeriveConfig, ResolveDeriveConfig } from '../claude/session-aggregate.ts';
import { deriveName } from '../derive/name.ts';
import { matchesProd } from '../derive/prod.ts';
import { isTestCommand, parseTestOutput } from '../derive/tests.ts';
import { extractTickets } from '../derive/tickets.ts';
import { addUnique } from '../derive/util.ts';
import type { EventKind, TimelineEvent } from '../types/events.ts';
import type { Availability, Session, TestResult, Usage } from '../types/session.ts';
import { emptyUsage } from '../types/session.ts';
import { type CodexEnvelope, codexShellCommand, parseCodexEnvelope } from './rollout.ts';

export interface CodexAggState {
  version: 1;
  sessionId: string | null;
  seq: number;
  turn: number;
  startCwd: string | null;
  cwds: string[];
  originator: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  models: string[];
  usage: Usage;
  tickets: string[];
  skills: string[];
  filesTouched: string[];
  promptCount: number;
  toolCallCount: number;
  apiErrorCount: number;
  pendingTests: Record<string, string>;
  lastTest: TestResult | null;
  touchedProd: boolean;
  unknownTypes: Record<string, number>;
}

type Obj = Record<string, unknown>;
const SHELL_TOOLS = new Set(['shell', 'exec_command', 'local_shell', 'shell_command']);
const INJECTED = ['<environment_context>', '<user_instructions>', '# AGENTS.md'];
const TOOL_RESULT_MAX = 4000;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function createCodexAggState(): CodexAggState {
  return {
    version: 1,
    sessionId: null,
    seq: 0,
    turn: 0,
    startCwd: null,
    cwds: [],
    originator: null,
    firstPrompt: null,
    lastPrompt: null,
    startedAt: null,
    lastActivityAt: null,
    models: [],
    usage: emptyUsage(),
    tickets: [],
    skills: [],
    filesTouched: [],
    promptCount: 0,
    toolCallCount: 0,
    apiErrorCount: 0,
    pendingTests: {},
    lastTest: null,
    touchedProd: false,
    unknownTypes: {},
  };
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isObj)
    .map((b) => str(b.text) ?? '')
    .filter(Boolean)
    .join('\n');
}

function outputText(output: unknown): string {
  if (isObj(output)) return str(output.output) ?? blockText(output.content);
  if (typeof output !== 'string') return '';
  try {
    const parsed: unknown = JSON.parse(output);
    if (isObj(parsed) && typeof parsed.output === 'string') return parsed.output;
  } catch {
    // plain text output
  }
  return output;
}

function newEvent(state: CodexAggState, env: CodexEnvelope, kind: EventKind): TimelineEvent {
  state.seq += 1;
  const sid = state.sessionId ?? 'codex';
  return {
    sessionId: sid,
    agentId: null,
    uuid: `${sid}:${env.ordinal ?? state.seq}`,
    parentUuid: null,
    seq: state.seq,
    ts: env.timestamp,
    kind,
    turn: state.turn,
    text: null,
    tool: null,
    toolUseId: null,
    mcpServer: null,
    input: null,
    messageId: null,
    model: null,
    usage: null,
    durationMs: null,
  };
}

interface ToolCallInput {
  name: string;
  input: unknown;
  command: string | null;
  cfg: DeriveConfig;
}

function onToolCall(state: CodexAggState, env: CodexEnvelope, t: ToolCallInput): TimelineEvent {
  const { name, input, command, cfg } = t;
  state.toolCallCount += 1;
  const e = newEvent(state, env, 'tool_call');
  e.tool = name;
  e.toolUseId = str(env.payload.call_id);
  e.input = input;
  if (command) {
    addUnique(state.tickets, extractTickets(command, cfg.ticketRegex));
    if (matchesProd(command, cfg.prodPatterns)) state.touchedProd = true;
    if (e.toolUseId && isTestCommand(command)) state.pendingTests[e.toolUseId] = command;
  }
  if (name === 'apply_patch' && typeof input === 'string') {
    for (const m of input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      if (m[1]) addUnique(state.filesTouched, [m[1].trim()]);
    }
  }
  return e;
}

function onResponseItem(state: CodexAggState, env: CodexEnvelope, cfg: DeriveConfig): TimelineEvent[] {
  const p = env.payload;
  switch (p.type) {
    case 'message': {
      const text = blockText(p.content);
      if (p.role === 'user') {
        if (INJECTED.some((prefix) => text.trimStart().startsWith(prefix))) return [];
        state.turn += 1;
        state.promptCount += 1;
        if (state.firstPrompt === null) state.firstPrompt = text;
        state.lastPrompt = text;
        addUnique(state.tickets, extractTickets(text, cfg.ticketRegex));
        const e = newEvent(state, env, 'prompt');
        e.text = text;
        return [e];
      }
      if (p.role === 'assistant') {
        const e = newEvent(state, env, 'assistant_text');
        e.text = text;
        return [e];
      }
      return [];
    }
    case 'reasoning': {
      const summary = Array.isArray(p.summary) ? blockText(p.summary) : '';
      if (!summary) return [];
      const e = newEvent(state, env, 'thinking');
      e.text = summary;
      return [e];
    }
    case 'function_call': {
      const name = str(p.name) ?? 'unknown';
      let input: unknown = p.arguments ?? null;
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          // keep raw string
        }
      }
      const command = SHELL_TOOLS.has(name) ? codexShellCommand(p.arguments) : null;
      return [onToolCall(state, env, { name, input, command, cfg })];
    }
    case 'custom_tool_call': {
      const name = str(p.name) ?? 'unknown';
      return [onToolCall(state, env, { name, input: p.input ?? null, command: null, cfg })];
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const e = newEvent(state, env, 'tool_result');
      e.toolUseId = str(p.call_id);
      const text = outputText(p.output);
      e.text = text.length > TOOL_RESULT_MAX ? `${text.slice(0, TOOL_RESULT_MAX)}…` : text;
      const command = e.toolUseId ? state.pendingTests[e.toolUseId] : undefined;
      if (e.toolUseId && command !== undefined) {
        const { [e.toolUseId]: _done, ...rest } = state.pendingTests;
        state.pendingTests = rest;
        const r = parseTestOutput(command, text, e.ts);
        if (r) state.lastTest = r;
      }
      return [e];
    }
    default:
      return [];
  }
}

function onEventMsg(state: CodexAggState, env: CodexEnvelope): TimelineEvent[] {
  const p = env.payload;
  if (p.type === 'token_count') {
    const info = isObj(p.info) ? p.info : null;
    const total = info && isObj(info.total_token_usage) ? info.total_token_usage : null;
    if (total) {
      const cached = num(total.cached_input_tokens);
      state.usage = {
        input: Math.max(0, num(total.input_tokens) - cached),
        output: num(total.output_tokens),
        cacheRead: cached,
        cacheWrite: 0,
        costUsd: null,
      };
    }
    return [];
  }
  if (p.type === 'error') {
    state.apiErrorCount += 1;
    const e = newEvent(state, env, 'error');
    e.text = str(p.message) ?? 'error';
    return [e];
  }
  return [];
}

export function ingestCodexRecord(
  state: CodexAggState,
  value: unknown,
  resolve: ResolveDeriveConfig,
): TimelineEvent[] {
  const env = parseCodexEnvelope(value);
  if (!env) {
    state.unknownTypes['(invalid)'] = (state.unknownTypes['(invalid)'] ?? 0) + 1;
    return [];
  }
  if (!state.startedAt || env.timestamp < state.startedAt) state.startedAt = env.timestamp;
  if (!state.lastActivityAt || env.timestamp > state.lastActivityAt) state.lastActivityAt = env.timestamp;
  switch (env.type) {
    case 'session_meta': {
      const p = env.payload;
      state.sessionId = str(p.id) ?? str(p.session_id) ?? state.sessionId;
      state.originator = str(p.originator) ?? state.originator;
      const cwd = str(p.cwd);
      if (cwd) {
        if (!state.startCwd) state.startCwd = cwd;
        addUnique(state.cwds, [cwd]);
      }
      return [];
    }
    case 'turn_context': {
      const model = str(env.payload.model);
      if (model) addUnique(state.models, [model]);
      const cwd = str(env.payload.cwd);
      if (cwd) addUnique(state.cwds, [cwd]);
      return [];
    }
    case 'response_item':
      return onResponseItem(state, env, resolve(state.startCwd));
    case 'event_msg':
      return onEventMsg(state, env);
    case 'world_state':
    case 'compacted':
      return [];
    default:
      state.unknownTypes[env.type] = (state.unknownTypes[env.type] ?? 0) + 1;
      return [];
  }
}

export function codexStateToSession(
  state: CodexAggState,
  o: { projectId: string | null; transcriptPath: string | null; availability: Availability },
): Session | null {
  if (!state.sessionId || !state.startedAt) return null;
  return {
    id: state.sessionId,
    source: 'codex',
    projectId: o.projectId,
    startCwd: state.startCwd ?? '',
    cwds: [...state.cwds],
    name: deriveName({
      agentName: null,
      customTitle: null,
      aiTitle: null,
      summary: null,
      firstPrompt: state.firstPrompt,
    }),
    firstPrompt: state.firstPrompt,
    lastPrompt: state.lastPrompt,
    awaySummary: null,
    recap: null,
    startedAt: state.startedAt,
    lastActivityAt: state.lastActivityAt ?? state.startedAt,
    models: [...state.models],
    permissionMode: null,
    usage: { ...state.usage },
    linesAdded: null,
    linesRemoved: null,
    prs: [],
    tickets: [...state.tickets],
    skills: [...state.skills],
    mcpServers: [],
    filesTouched: [...state.filesTouched],
    promptCount: state.promptCount,
    toolCallCount: state.toolCallCount,
    apiErrorCount: state.apiErrorCount,
    flags: {
      touchedProd: state.touchedProd,
      hasSubagents: false,
      automated: state.originator === 'codex_sdk_ts',
    },
    availability: o.availability,
    transcriptPath: o.transcriptPath,
    lastTest: state.lastTest ? { ...state.lastTest } : null,
    live: null,
  };
}
