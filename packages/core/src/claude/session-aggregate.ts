import { deriveName } from '../derive/name.ts';
import { matchesProd } from '../derive/prod.ts';
import { mcpServerOf, slashCommand } from '../derive/skills.ts';
import { isTestCommand, parseTestOutput } from '../derive/tests.ts';
import { extractTickets } from '../derive/tickets.ts';
import { addUnique } from '../derive/util.ts';
import type { EventKind, TimelineEvent } from '../types/events.ts';
import type { Availability, PrRef, Session, TestResult, Usage } from '../types/session.ts';
import { emptyUsage } from '../types/session.ts';
import {
  type ClaudeMessageRecord,
  classifyClaudeRecord,
  contentText,
  type SessionMetaType,
} from './records.ts';

export interface DeriveConfig {
  ticketRegex: RegExp | null;
  prodPatterns: RegExp[];
}
export type ResolveDeriveConfig = (startCwd: string | null) => DeriveConfig;

export interface CostStateSnapshot {
  totalCostUSD: number;
  linesAdded: number | null;
  linesRemoved: number | null;
  usage: Usage;
}

export interface ClaudeAggState {
  version: 1;
  sessionId: string | null;
  agentId: string | null;
  seq: number;
  turn: number;
  startCwd: string | null;
  cwds: string[];
  firstPrompt: string | null;
  lastHumanPrompt: string | null;
  lastPromptMeta: string | null;
  agentName: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  summary: string | null;
  awaySummary: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  models: string[];
  permissionMode: string | null;
  usage: Usage;
  seenMessageIds: string[];
  costState: CostStateSnapshot | null;
  prs: PrRef[];
  tickets: string[];
  skills: string[];
  mcpServers: string[];
  filesTouched: string[];
  promptCount: number;
  toolCallCount: number;
  apiErrorCount: number;
  pendingTests: Record<string, string>;
  lastTest: TestResult | null;
  touchedProd: boolean;
  lastEventKind: EventKind | null;
  unknownTypes: Record<string, number>;
}

type Obj = Record<string, unknown>;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TOOL_RESULT_MAX = 4000;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function usageFromClaude(u: Obj | undefined): Usage | null {
  if (!u) return null;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    costUsd: null,
  };
}

function addUsage(into: Usage, u: Usage): void {
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheWrite += u.cacheWrite;
}

export function createClaudeAggState(
  sessionId: string | null,
  agentId: string | null = null,
): ClaudeAggState {
  return {
    version: 1,
    sessionId,
    agentId,
    seq: 0,
    turn: 0,
    startCwd: null,
    cwds: [],
    firstPrompt: null,
    lastHumanPrompt: null,
    lastPromptMeta: null,
    agentName: null,
    customTitle: null,
    aiTitle: null,
    summary: null,
    awaySummary: null,
    startedAt: null,
    lastActivityAt: null,
    models: [],
    permissionMode: null,
    usage: emptyUsage(),
    seenMessageIds: [],
    costState: null,
    prs: [],
    tickets: [],
    skills: [],
    mcpServers: [],
    filesTouched: [],
    promptCount: 0,
    toolCallCount: 0,
    apiErrorCount: 0,
    pendingTests: {},
    lastTest: null,
    touchedProd: false,
    lastEventKind: null,
    unknownTypes: {},
  };
}

// Transient lookup cache; the serialisable source of truth is state.seenMessageIds.
const seenCache = new WeakMap<ClaudeAggState, Set<string>>();

function markSeen(state: ClaudeAggState, id: string): boolean {
  let set = seenCache.get(state);
  if (!set) {
    set = new Set(state.seenMessageIds);
    seenCache.set(state, set);
  }
  if (set.has(id)) return false;
  set.add(id);
  state.seenMessageIds.push(id);
  return true;
}

function touch(state: ClaudeAggState, rec: Obj): void {
  const ts = str(rec.timestamp);
  if (ts) {
    if (!state.startedAt || ts < state.startedAt) state.startedAt = ts;
    if (!state.lastActivityAt || ts > state.lastActivityAt) state.lastActivityAt = ts;
  }
  const cwd = str(rec.cwd);
  if (cwd) {
    if (!state.startCwd) state.startCwd = cwd;
    addUnique(state.cwds, [cwd]);
  }
}

function newEvent(
  state: ClaudeAggState,
  rec: ClaudeMessageRecord,
  index: number,
  kind: EventKind,
): TimelineEvent {
  state.seq += 1;
  state.lastEventKind = kind;
  const uuid = typeof rec.uuid === 'string' ? rec.uuid : `${state.sessionId ?? 'session'}-${state.seq}`;
  return {
    sessionId: state.sessionId ?? rec.sessionId,
    agentId: state.agentId,
    uuid: index === 0 ? uuid : `${uuid}#${index}`,
    parentUuid: typeof rec.parentUuid === 'string' ? rec.parentUuid : null,
    seq: state.seq,
    ts: str(rec.timestamp) ?? state.lastActivityAt ?? '',
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

function repoFromUrl(url: string): string {
  return /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? '';
}

function parseCostState(rec: Obj): CostStateSnapshot | null {
  if (typeof rec.totalCostUSD !== 'number') return null;
  const usage = emptyUsage();
  if (isObj(rec.modelUsage)) {
    for (const m of Object.values(rec.modelUsage)) {
      if (!isObj(m)) continue;
      usage.input += num(m.inputTokens);
      usage.output += num(m.outputTokens);
      usage.cacheRead += num(m.cacheReadInputTokens);
      usage.cacheWrite += num(m.cacheCreationInputTokens);
    }
  }
  usage.costUsd = rec.totalCostUSD;
  return {
    totalCostUSD: rec.totalCostUSD,
    linesAdded: typeof rec.totalLinesAdded === 'number' ? rec.totalLinesAdded : null,
    linesRemoved: typeof rec.totalLinesRemoved === 'number' ? rec.totalLinesRemoved : null,
    usage,
  };
}

function applySessionMeta(state: ClaudeAggState, type: SessionMetaType, rec: Obj): void {
  if (!state.sessionId) state.sessionId = str(rec.sessionId);
  switch (type) {
    case 'agent-name':
      state.agentName = str(rec.agentName) ?? state.agentName;
      break;
    case 'ai-title':
      state.aiTitle = str(rec.aiTitle) ?? state.aiTitle;
      break;
    case 'custom-title':
      state.customTitle = str(rec.customTitle) ?? str(rec.title) ?? state.customTitle;
      break;
    case 'summary':
      state.summary = str(rec.summary) ?? state.summary;
      break;
    case 'last-prompt':
      state.lastPromptMeta = str(rec.lastPrompt) ?? state.lastPromptMeta;
      break;
    case 'permission-mode':
    case 'mode':
      state.permissionMode = str(rec.permissionMode) ?? str(rec.mode) ?? state.permissionMode;
      break;
    case 'pr-link': {
      const url = str(rec.prUrl);
      const n = typeof rec.prNumber === 'number' ? rec.prNumber : Number(rec.prNumber);
      if (url && Number.isFinite(n) && !state.prs.some((p) => p.url === url)) {
        state.prs.push({ repo: str(rec.prRepository) ?? repoFromUrl(url), number: n, url });
      }
      break;
    }
    case 'cost-state':
      state.costState = parseCostState(rec) ?? state.costState;
      break;
    default:
      break;
  }
}

function onPrompt(
  state: ClaudeAggState,
  rec: ClaudeMessageRecord,
  text: string,
  cfg: DeriveConfig,
): TimelineEvent {
  state.turn += 1;
  state.promptCount += 1;
  if (state.firstPrompt === null) state.firstPrompt = text;
  state.lastHumanPrompt = text;
  addUnique(state.tickets, extractTickets(text, cfg.ticketRegex));
  const cmd = slashCommand(text);
  if (cmd) addUnique(state.skills, [cmd]);
  const e = newEvent(state, rec, 0, 'prompt');
  e.text = text;
  return e;
}

function stdoutOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return '';
  return [str(v.stdout), str(v.stderr)].filter((x): x is string => Boolean(x)).join('\n');
}

function recordTest(
  state: ClaudeAggState,
  toolUseId: string | null,
  text: string,
  rec: ClaudeMessageRecord,
  ts: string,
): void {
  if (!toolUseId) return;
  const command = state.pendingTests[toolUseId];
  if (command === undefined) return;
  const { [toolUseId]: _done, ...rest } = state.pendingTests;
  state.pendingTests = rest;
  const result =
    parseTestOutput(command, text, ts) ?? parseTestOutput(command, stdoutOf(rec.toolUseResult), ts);
  if (result) state.lastTest = result;
}

function onToolResult(state: ClaudeAggState, rec: ClaudeMessageRecord): TimelineEvent[] {
  const content = rec.message?.content;
  const blocks = Array.isArray(content)
    ? content.filter((b): b is Obj => isObj(b) && b.type === 'tool_result')
    : [];
  const out: TimelineEvent[] = [];
  const clip = (t: string) => (t.length > TOOL_RESULT_MAX ? `${t.slice(0, TOOL_RESULT_MAX)}…` : t);
  for (const [i, b] of blocks.entries()) {
    const toolUseId = str(b.tool_use_id);
    const text = typeof b.content === 'string' ? b.content : contentText(b.content);
    const e = newEvent(state, rec, i, 'tool_result');
    e.toolUseId = toolUseId;
    e.text = clip(text);
    out.push(e);
    recordTest(state, toolUseId, text, rec, e.ts);
  }
  if (blocks.length === 0) {
    const e = newEvent(state, rec, 0, 'tool_result');
    e.text = clip(stdoutOf(rec.toolUseResult));
    out.push(e);
  }
  return out;
}

function onToolUse(
  state: ClaudeAggState,
  name: string,
  toolUseId: string | null,
  input: unknown,
  cfg: DeriveConfig,
): void {
  state.toolCallCount += 1;
  const inp = isObj(input) ? input : {};
  const server = mcpServerOf(name);
  if (server) {
    addUnique(state.mcpServers, [server]);
    addUnique(state.tickets, extractTickets(JSON.stringify(inp), cfg.ticketRegex));
    if (matchesProd(name, cfg.prodPatterns)) state.touchedProd = true;
  }
  if (name === 'Skill') {
    const skill = str(inp.skill);
    if (skill) {
      addUnique(state.skills, [skill]);
      if (matchesProd(skill, cfg.prodPatterns)) state.touchedProd = true;
    }
    addUnique(state.tickets, extractTickets(str(inp.args) ?? '', cfg.ticketRegex));
  }
  if (name === 'Bash') {
    const command = str(inp.command) ?? '';
    addUnique(state.tickets, extractTickets(command, cfg.ticketRegex));
    if (matchesProd(command, cfg.prodPatterns)) state.touchedProd = true;
    if (toolUseId && isTestCommand(command)) state.pendingTests[toolUseId] = command;
  }
  if (EDIT_TOOLS.has(name)) {
    const file = str(inp.file_path) ?? str(inp.notebook_path);
    if (file) addUnique(state.filesTouched, [file]);
  }
}

function onAssistant(state: ClaudeAggState, rec: ClaudeMessageRecord, cfg: DeriveConfig): TimelineEvent[] {
  const msg = rec.message ?? {};
  const model = str(msg.model);
  if (model && model !== '<synthetic>') addUnique(state.models, [model]);
  const isError = rec.isApiErrorMessage === true;
  if (isError) state.apiErrorCount += 1;
  if (typeof rec.attributionSkill === 'string') addUnique(state.skills, [rec.attributionSkill]);

  const messageId = str(msg.id);
  let usage: Usage | null = null;
  const u = usageFromClaude(isObj(msg.usage) ? msg.usage : undefined);
  if (u && (messageId === null || markSeen(state, messageId))) {
    addUsage(state.usage, u);
    usage = u;
  }

  const blocks: Obj[] = Array.isArray(msg.content)
    ? msg.content.filter(isObj)
    : typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : [];
  const out: TimelineEvent[] = [];
  for (const [i, b] of blocks.entries()) {
    let e: TimelineEvent | null = null;
    if (b.type === 'text') {
      e = newEvent(state, rec, i, isError ? 'error' : 'assistant_text');
      e.text = str(b.text) ?? '';
    } else if (b.type === 'thinking') {
      e = newEvent(state, rec, i, 'thinking');
      e.text = str(b.thinking) ?? '';
    } else if (b.type === 'tool_use') {
      e = newEvent(state, rec, i, 'tool_call');
      const name = str(b.name) ?? 'unknown';
      e.tool = name;
      e.toolUseId = str(b.id);
      e.input = b.input ?? null;
      e.mcpServer = mcpServerOf(name);
      onToolUse(state, name, e.toolUseId, b.input, cfg);
    }
    if (!e) continue;
    e.messageId = messageId;
    e.model = model;
    if (usage) {
      e.usage = usage;
      usage = null;
    }
    out.push(e);
  }
  return out;
}

function onSystem(state: ClaudeAggState, rec: ClaudeMessageRecord, subtype: string | null): TimelineEvent {
  const level = str((rec as unknown as Obj).level);
  const kind: EventKind = subtype === 'api_error' || level === 'error' ? 'error' : 'system';
  if (kind === 'error') state.apiErrorCount += 1;
  const e = newEvent(state, rec, 0, kind);
  e.tool = subtype;
  if (subtype === 'turn_duration') {
    e.durationMs = typeof rec.durationMs === 'number' ? rec.durationMs : null;
  } else {
    e.text = contentText(rec.content) || subtype;
  }
  if (subtype === 'away_summary') state.awaySummary = e.text;
  return e;
}

/**
 * `command` (`<command-name>`/`<local-command-stdout>`) and `compact_summary` records are not
 * human prompts: they must not increment promptCount/turn, seed firstPrompt/lastPrompt, or seed
 * the session name. They still belong in the timeline, as a `system` event tagged with
 * `tool: 'command'` / `tool: 'compact_summary'` so the UI can render them distinctly from real
 * assistant/system activity.
 */
function onCommandOrCompact(
  state: ClaudeAggState,
  rec: ClaudeMessageRecord,
  tool: 'command' | 'compact_summary',
  text: string,
): TimelineEvent {
  const e = newEvent(state, rec, 0, 'system');
  e.tool = tool;
  e.text = text;
  return e;
}

export function ingestClaudeRecord(
  state: ClaudeAggState,
  value: unknown,
  resolve: ResolveDeriveConfig,
): TimelineEvent[] {
  const c = classifyClaudeRecord(value);
  if (c.kind === 'unknown') {
    const key = c.type ?? '(invalid)';
    state.unknownTypes[key] = (state.unknownTypes[key] ?? 0) + 1;
    return [];
  }
  if (c.kind === 'ignored') return [];
  if (c.kind === 'session_meta') {
    applySessionMeta(state, c.type, c.rec);
    return [];
  }
  const rec = c.rec;
  const raw = rec as unknown as Obj;
  if (!state.sessionId && typeof rec.sessionId === 'string') state.sessionId = rec.sessionId;
  touch(state, raw);
  const pm = str(raw.permissionMode);
  if (pm) state.permissionMode = pm;
  const cfg = resolve(state.startCwd);
  switch (c.kind) {
    case 'human_prompt':
      return [onPrompt(state, rec, c.text, cfg)];
    case 'command':
      return [onCommandOrCompact(state, rec, 'command', c.text)];
    case 'compact_summary':
      return [onCommandOrCompact(state, rec, 'compact_summary', contentText(rec.message?.content))];
    case 'tool_result':
      return onToolResult(state, rec);
    case 'assistant':
      return onAssistant(state, rec, cfg);
    case 'system':
      return [onSystem(state, rec, c.subtype)];
    default:
      return [];
  }
}

export function claudeStateToSession(
  state: ClaudeAggState,
  o: {
    projectId: string | null;
    transcriptPath: string | null;
    availability: Availability;
    hasSubagents: boolean;
  },
): Session | null {
  if (!state.sessionId || !state.startedAt) return null;
  const usage: Usage = state.costState ? { ...state.costState.usage } : { ...state.usage };
  return {
    id: state.sessionId,
    source: 'claude',
    projectId: o.projectId,
    startCwd: state.startCwd ?? '',
    cwds: [...state.cwds],
    name: deriveName({
      agentName: state.agentName,
      customTitle: state.customTitle,
      aiTitle: state.aiTitle,
      summary: state.summary,
      firstPrompt: state.firstPrompt,
    }),
    firstPrompt: state.firstPrompt,
    lastPrompt: state.lastPromptMeta ?? state.lastHumanPrompt,
    awaySummary: state.awaySummary,
    recap: null,
    startedAt: state.startedAt,
    lastActivityAt: state.lastActivityAt ?? state.startedAt,
    models: [...state.models],
    permissionMode: state.permissionMode,
    usage,
    linesAdded: state.costState?.linesAdded ?? null,
    linesRemoved: state.costState?.linesRemoved ?? null,
    prs: state.prs.map((p) => ({ ...p })),
    tickets: [...state.tickets],
    skills: [...state.skills],
    mcpServers: [...state.mcpServers],
    filesTouched: [...state.filesTouched],
    promptCount: state.promptCount,
    toolCallCount: state.toolCallCount,
    apiErrorCount: state.apiErrorCount,
    flags: { touchedProd: state.touchedProd, hasSubagents: o.hasSubagents, automated: false },
    availability: o.availability,
    transcriptPath: o.transcriptPath,
    lastTest: state.lastTest ? { ...state.lastTest } : null,
    live: null,
  };
}
