import type { AgentNode } from '@orc/core';
import type { Edge, Node } from '@xyflow/react';
import { type ConductorStep, conductorStep } from './conductor.ts';

export const ROOT_ID = 'main';
const COL_W = 300;
const ROW_H = 96;

export interface AgentNodeData extends Record<string, unknown> {
  agent: AgentNode | null;
  label: string;
  childCount: number;
  collapsed: boolean;
  step: ConductorStep | null;
}

export function childrenIndex(agents: readonly AgentNode[]): Map<string, AgentNode[]> {
  const ids = new Set(agents.map((a) => a.id));
  const map = new Map<string, AgentNode[]>();
  for (const a of agents) {
    const parent = a.parentId !== null && ids.has(a.parentId) ? a.parentId : ROOT_ID;
    const list = map.get(parent);
    if (list) list.push(a);
    else map.set(parent, [a]);
  }
  for (const list of map.values())
    list.sort((x, y) => (x.startedAt < y.startedAt ? -1 : x.startedAt > y.startedAt ? 1 : 0));
  return map;
}

export function defaultCollapsed(agents: readonly AgentNode[]): Set<string> {
  const kids = childrenIndex(agents);
  const hot = (a: AgentNode): boolean => a.status !== 'done' || (kids.get(a.id) ?? []).some(hot);
  const out = new Set<string>();
  for (const a of agents) if ((kids.get(a.id) ?? []).length > 0 && !hot(a)) out.add(a.id);
  return out;
}

export function layoutAgentTree(
  agents: readonly AgentNode[],
  collapsed: ReadonlySet<string>,
  rootLabel: string,
): { nodes: Node<AgentNodeData, 'agent'>[]; edges: Edge[] } {
  const kids = childrenIndex(agents);
  const nodes: Node<AgentNodeData, 'agent'>[] = [];
  const edges: Edge[] = [];
  let row = 0;

  const place = (id: string, agent: AgentNode | null, depth: number): number => {
    const children = kids.get(id) ?? [];
    const isCollapsed = collapsed.has(id);
    const visible = isCollapsed ? [] : children;
    let y: number;
    if (visible.length === 0) {
      y = row * ROW_H;
      row++;
    } else {
      const ys = visible.map((c) => {
        edges.push({ id: `${id}->${c.id}`, source: id, target: c.id, animated: c.status === 'running' });
        return place(c.id, c, depth + 1);
      });
      const first = ys[0] ?? 0;
      const last = ys[ys.length - 1] ?? first;
      y = (first + last) / 2;
    }
    nodes.push({
      id,
      type: 'agent',
      position: { x: depth * COL_W, y },
      data: {
        agent,
        label: agent ? agent.description || agent.agentType : rootLabel,
        childCount: children.length,
        collapsed: isCollapsed,
        step: agent ? conductorStep(agent) : null,
      },
    });
    return y;
  };

  place(ROOT_ID, null, 0);
  return { nodes, edges };
}
