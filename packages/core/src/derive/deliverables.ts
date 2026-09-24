import type { TimelineEvent } from '../types/index.ts';
import { isToolError } from './step-stats.ts';

export type DeliverableStatus = 'applied' | 'failed' | 'pending';

export interface FileChange {
  path: string;
  tool: string;
  toolUseId: string | null;
  turn: number;
  seq: number;
  ts: string;
  agentId: string | null;
  status: DeliverableStatus;
  oldText: string | null;
  newText: string | null;
}

export interface DeliverableFile {
  path: string;
  tools: string[];
  ops: number;
  status: DeliverableStatus;
  lastTs: string;
}

export interface TurnDeliverables {
  turn: number;
  agentId: string | null;
  files: DeliverableFile[];
}

export interface FileSummary {
  path: string;
  ops: number;
  failedOps: number;
  turns: number[];
  agentIds: Array<string | null>;
  firstTs: string;
  lastTs: string;
  changes: FileChange[];
}

export const FILE_EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'] as const;
const TOOL_SET = new Set<string>(FILE_EDIT_TOOLS);
const MAX_TEXT = 4000;
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const STATUS_RANK: Record<DeliverableStatus, number> = { failed: 0, pending: 1, applied: 2 };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const clip = (v: string | null): string | null =>
  v !== null && v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v;

function patchText(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (isObj(input)) return str(input.input) ?? str(input.patch);
  return null;
}

function joinEdits(edits: unknown, key: 'old_string' | 'new_string'): string | null {
  if (!Array.isArray(edits)) return null;
  const parts = edits.filter(isObj).map((e) => str(e[key]) ?? '');
  return parts.length ? parts.join('\n…\n') : null;
}

function targets(e: TimelineEvent): Array<{ path: string; oldText: string | null; newText: string | null }> {
  const input = e.input;
  switch (e.tool) {
    case 'Edit': {
      const path = isObj(input) ? str(input.file_path) : null;
      return path && isObj(input)
        ? [{ path, oldText: str(input.old_string), newText: str(input.new_string) }]
        : [];
    }
    case 'Write': {
      const path = isObj(input) ? str(input.file_path) : null;
      return path && isObj(input) ? [{ path, oldText: null, newText: str(input.content) }] : [];
    }
    case 'MultiEdit': {
      const path = isObj(input) ? str(input.file_path) : null;
      return path && isObj(input)
        ? [
            {
              path,
              oldText: joinEdits(input.edits, 'old_string'),
              newText: joinEdits(input.edits, 'new_string'),
            },
          ]
        : [];
    }
    case 'NotebookEdit': {
      const path = isObj(input) ? str(input.notebook_path) : null;
      return path && isObj(input) ? [{ path, oldText: null, newText: str(input.new_source) }] : [];
    }
    case 'apply_patch': {
      const text = patchText(input);
      if (!text) return [];
      return [...text.matchAll(PATCH_FILE)]
        .map((m) => m[1]?.trim())
        .filter((p): p is string => Boolean(p))
        .map((path) => ({ path, oldText: null, newText: text }));
    }
    default:
      return [];
  }
}

export function extractFileChanges(events: readonly TimelineEvent[]): FileChange[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const results = new Map<string, TimelineEvent>();
  for (const e of sorted) {
    if ((e.kind === 'tool_result' || e.kind === 'error') && e.toolUseId) results.set(e.toolUseId, e);
  }
  const out: FileChange[] = [];
  for (const e of sorted) {
    if (e.kind !== 'tool_call' || e.tool === null || !TOOL_SET.has(e.tool)) continue;
    const r = e.toolUseId ? results.get(e.toolUseId) : undefined;
    const status: DeliverableStatus = !r ? 'pending' : isToolError(r) ? 'failed' : 'applied';
    for (const t of targets(e)) {
      out.push({
        path: t.path,
        tool: e.tool,
        toolUseId: e.toolUseId,
        turn: e.turn,
        seq: e.seq,
        ts: e.ts,
        agentId: e.agentId,
        status,
        oldText: clip(t.oldText),
        newText: clip(t.newText),
      });
    }
  }
  return out;
}

export function deliverablesByTurn(events: readonly TimelineEvent[]): TurnDeliverables[] {
  const groups = new Map<
    string,
    { turn: number; agentId: string | null; files: Map<string, DeliverableFile> }
  >();
  for (const c of extractFileChanges(events)) {
    const key = `${c.agentId ?? ''}|${c.turn}`;
    let g = groups.get(key);
    if (!g) {
      g = { turn: c.turn, agentId: c.agentId, files: new Map() };
      groups.set(key, g);
    }
    const f = g.files.get(c.path);
    if (!f) {
      g.files.set(c.path, { path: c.path, tools: [c.tool], ops: 1, status: c.status, lastTs: c.ts });
      continue;
    }
    f.ops++;
    if (!f.tools.includes(c.tool)) f.tools.push(c.tool);
    if (STATUS_RANK[c.status] > STATUS_RANK[f.status]) f.status = c.status;
    if (c.ts > f.lastTs) f.lastTs = c.ts;
  }
  return [...groups.values()].map((g) => ({
    turn: g.turn,
    agentId: g.agentId,
    files: [...g.files.values()],
  }));
}

export function summarizeFiles(changes: readonly FileChange[]): FileSummary[] {
  const byPath = new Map<string, FileSummary>();
  for (const c of changes) {
    let s = byPath.get(c.path);
    if (!s) {
      s = {
        path: c.path,
        ops: 0,
        failedOps: 0,
        turns: [],
        agentIds: [],
        firstTs: c.ts,
        lastTs: c.ts,
        changes: [],
      };
      byPath.set(c.path, s);
    }
    s.ops++;
    if (c.status === 'failed') s.failedOps++;
    if (!s.turns.includes(c.turn)) s.turns.push(c.turn);
    if (!s.agentIds.includes(c.agentId)) s.agentIds.push(c.agentId);
    if (c.ts < s.firstTs) s.firstTs = c.ts;
    if (c.ts > s.lastTs) s.lastTs = c.ts;
    s.changes.push(c);
  }
  return [...byPath.values()].sort((a, b) => (a.lastTs === b.lastTs ? 0 : a.lastTs < b.lastTs ? 1 : -1));
}
