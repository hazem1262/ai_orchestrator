import type { AgentNode } from '@orc/core';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useState } from 'react';
import { AgentCard } from './AgentCard.tsx';
import { AgentOutline } from './AgentOutline.tsx';
import { defaultCollapsed, layoutAgentTree, ROOT_ID } from './layout.ts';

const nodeTypes = { agent: AgentCard };

interface Props {
  agents: AgentNode[];
  rootLabel: string;
  onOpenAgent: (agentId: string | null) => void;
}

export function AgentsTree({ agents, rootLabel, onOpenAgent }: Props) {
  // Reset default expansion only when the set of agents or their statuses change.
  const shape = agents.map((a) => `${a.id}:${a.status}`).join('|');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => defaultCollapsed(agents));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape` captures the relevant changes of `agents`
  useEffect(() => setCollapsed(defaultCollapsed(agents)), [shape]);

  const { nodes, edges } = useMemo(
    () => layoutAgentTree(agents, collapsed, rootLabel),
    [agents, collapsed, rootLabel],
  );

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (agents.length === 0)
    return <p className="p-3 text-sm text-neutral-500">This session started no subagents.</p>;

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[1fr_280px]">
      <div className="h-[560px] rounded border border-neutral-200" data-testid="agents-tree">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_e, n) => onOpenAgent(n.id === ROOT_ID ? null : n.id)}
          onNodeDoubleClick={(_e, n) => {
            if (n.id !== ROOT_ID) toggle(n.id);
          }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <AgentOutline
        agents={agents}
        collapsed={collapsed}
        onToggle={toggle}
        onOpenAgent={(id) => onOpenAgent(id)}
      />
    </div>
  );
}
