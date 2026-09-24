import type { TimelineEvent } from '@orc/core';
import type { ViewMode } from '@/stores/view-mode.ts';
import { toolLabel } from './format.ts';

export interface ToolStep {
  call: TimelineEvent;
  result: TimelineEvent | null;
}

export type TrajectoryItem =
  | { kind: 'text'; key: string; event: TimelineEvent }
  | { kind: 'thinking'; key: string; event: TimelineEvent }
  | { kind: 'tool_group'; key: string; label: string; calls: ToolStep[] }
  | { kind: 'tool'; key: string; label: string; step: ToolStep }
  | { kind: 'marker'; key: string; event: TimelineEvent };

export interface TurnView {
  key: string;
  turn: number;
  agentId: string | null;
  prompt: TimelineEvent | null;
  items: TrajectoryItem[];
}

export const turnKey = (agentId: string | null, turn: number) => `${agentId ?? 'main'}:${turn}`;

export function buildTurnViews(events: readonly TimelineEvent[], mode: ViewMode): TurnView[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const results = new Map<string, TimelineEvent>();
  for (const e of sorted) {
    if ((e.kind === 'tool_result' || e.kind === 'error') && e.toolUseId) results.set(e.toolUseId, e);
  }
  const turns: TurnView[] = [];
  let cur: TurnView | null = null;
  for (const e of sorted) {
    if (!cur || cur.turn !== e.turn || cur.agentId !== e.agentId) {
      cur = { key: turnKey(e.agentId, e.turn), turn: e.turn, agentId: e.agentId, prompt: null, items: [] };
      turns.push(cur);
    }
    if (e.kind === 'prompt') {
      if (cur.prompt === null) cur.prompt = e;
      else cur.items.push({ kind: 'text', key: `p-${e.seq}`, event: e });
      continue;
    }
    if (mode === 'summary') continue;
    switch (e.kind) {
      case 'assistant_text':
        cur.items.push({ kind: 'text', key: `x-${e.seq}`, event: e });
        break;
      case 'thinking':
        if (mode === 'verbose') cur.items.push({ kind: 'thinking', key: `k-${e.seq}`, event: e });
        break;
      case 'tool_call': {
        const step: ToolStep = { call: e, result: e.toolUseId ? (results.get(e.toolUseId) ?? null) : null };
        const label = toolLabel(e.tool ?? 'tool');
        if (mode === 'verbose') {
          cur.items.push({ kind: 'tool', key: `t-${e.seq}`, label, step });
          break;
        }
        const last = cur.items.at(-1);
        if (last && last.kind === 'tool_group' && last.label === label) last.calls.push(step);
        else cur.items.push({ kind: 'tool_group', key: `g-${e.seq}`, label, calls: [step] });
        break;
      }
      case 'system':
        cur.items.push({ kind: 'marker', key: `m-${e.seq}`, event: e });
        break;
      case 'error':
        if (!e.toolUseId) cur.items.push({ kind: 'marker', key: `m-${e.seq}`, event: e });
        break;
      default:
        break;
    }
  }
  return turns;
}
