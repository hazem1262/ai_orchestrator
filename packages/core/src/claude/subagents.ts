import type { AgentNode } from '../types/session.ts';
import type { ClaudeAggState } from './session-aggregate.ts';

export interface SubagentMeta {
  agentType: string;
  description: string;
  toolUseId: string | null;
  parentAgentId: string | null;
  spawnDepth: number;
  background: boolean;
}

export interface AgentTreeNode {
  node: AgentNode;
  children: AgentTreeNode[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function parseSubagentMeta(value: unknown): SubagentMeta {
  const v = isObj(value) ? value : {};
  const depth = typeof v.spawnDepth === 'number' && v.spawnDepth > 0 ? v.spawnDepth : 1;
  return {
    agentType: str(v.agentType) ?? 'unknown',
    description: str(v.description) ?? '',
    toolUseId: str(v.toolUseId),
    parentAgentId: str(v.parentAgentId),
    spawnDepth: depth,
    background: v.requestShape === 'background',
  };
}

export function agentIdFromPath(path: string): string | null {
  return /agent-([^/]+?)(?:\.meta\.json|\.jsonl)$/.exec(path)?.[1] ?? null;
}

export function claudeStateToAgentNode(
  state: ClaudeAggState,
  meta: SubagentMeta,
  o: { sessionId: string; agentId: string; transcriptPath: string },
): AgentNode {
  return {
    id: o.agentId,
    sessionId: o.sessionId,
    parentId: meta.parentAgentId,
    depth: meta.spawnDepth,
    agentType: meta.agentType,
    description: meta.description,
    background: meta.background,
    toolUseId: meta.toolUseId,
    usage: { ...state.usage },
    startedAt: state.startedAt ?? '',
    endedAt: state.lastActivityAt,
    // 'running' needs liveness (Phase 2); Phase 1 reports done/error from the transcript only.
    status: state.lastEventKind === 'error' ? 'error' : 'done',
    transcriptPath: o.transcriptPath,
  };
}

/**
 * Each node is placed exactly once: as a root (no resolvable parent) or as one parent's child.
 * A node caught in a `parentId` cycle — a self-cycle, or two-or-more nodes pointing at each
 * other — always has a parent that resolves inside the cycle, so it never reaches a root and is
 * intentionally left out of the returned tree; it does not throw, hang, or otherwise surface.
 * Use `unreachableAgentIds` to detect and report ids the tree silently dropped this way.
 */
export function buildAgentTree(nodes: AgentNode[]): AgentTreeNode[] {
  const byId = new Map<string, AgentTreeNode>();
  for (const n of nodes) byId.set(n.id, { node: n, children: [] });
  const roots: AgentTreeNode[] = [];
  for (const t of byId.values()) {
    const parent = t.node.parentId ? byId.get(t.node.parentId) : undefined;
    if (parent) parent.children.push(t);
    else roots.push(t);
  }
  const sortRec = (list: AgentTreeNode[]): void => {
    list.sort((a, b) => a.node.startedAt.localeCompare(b.node.startedAt));
    for (const c of list) sortRec(c.children);
  };
  sortRec(roots);
  return roots;
}

/** Ids that buildAgentTree cannot place in the tree because their parent chain forms a cycle. */
export function unreachableAgentIds(nodes: AgentNode[]): string[] {
  const reachable = new Set<string>();
  const walk = (list: AgentTreeNode[]): void => {
    for (const t of list) {
      if (reachable.has(t.node.id)) continue;
      reachable.add(t.node.id);
      walk(t.children);
    }
  };
  walk(buildAgentTree(nodes));
  return nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id);
}
