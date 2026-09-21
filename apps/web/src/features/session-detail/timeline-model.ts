import type { TimelineEvent } from '@orc/core';
import { mcpToolLabel } from '@orc/core/browser';

export interface ToolCall {
  call: TimelineEvent;
  result: TimelineEvent | null;
}

export type TimelineItem =
  | { type: 'event'; key: string; event: TimelineEvent }
  | { type: 'tools'; key: string; tool: string; label: string; calls: ToolCall[] };

export interface TurnGroup {
  turn: number;
  prompt: TimelineEvent | null;
  items: TimelineItem[];
}

export function toolLabel(tool: string): string {
  return mcpToolLabel(tool);
}

export function inputPreview(input: unknown): string {
  if (input === null || input === undefined) return '';
  let text: string;
  if (typeof input === 'string') text = input;
  else if (typeof input === 'object' && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    if (typeof o.command === 'string') text = o.command;
    else if (typeof o.file_path === 'string') text = o.file_path;
    else text = JSON.stringify(o);
  } else text = JSON.stringify(input);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export function groupTimeline(events: TimelineEvent[]): TurnGroup[] {
  const results = new Map<string, TimelineEvent>();
  const callIds = new Set<string>();
  for (const e of events) {
    if (e.kind === 'tool_result' && e.toolUseId) results.set(e.toolUseId, e);
    if (e.kind === 'tool_call' && e.toolUseId) callIds.add(e.toolUseId);
  }
  const turns: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  let tools: Extract<TimelineItem, { type: 'tools' }> | null = null;
  for (const e of events) {
    if (!current || e.turn !== current.turn) {
      current = { turn: e.turn, prompt: e.kind === 'prompt' ? e : null, items: [] };
      turns.push(current);
      tools = null;
      if (e.kind === 'prompt') continue;
    }
    if (e.kind === 'thinking') continue;
    if (e.kind === 'tool_result' && e.toolUseId && callIds.has(e.toolUseId)) continue;
    if (e.kind === 'tool_call' && e.tool) {
      const call: ToolCall = { call: e, result: e.toolUseId ? (results.get(e.toolUseId) ?? null) : null };
      if (tools && tools.tool === e.tool) {
        tools.calls.push(call);
      } else {
        tools = { type: 'tools', key: `t-${e.seq}`, tool: e.tool, label: toolLabel(e.tool), calls: [call] };
        current.items.push(tools);
      }
      continue;
    }
    tools = null;
    current.items.push({ type: 'event', key: `e-${e.seq}`, event: e });
  }
  return turns;
}
