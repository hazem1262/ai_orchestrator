import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { formatMs, formatTokens } from '@/features/session-detail/timeline/format.ts';
import type { AgentNodeData } from './layout.ts';

export type AgentFlowNode = Node<AgentNodeData, 'agent'>;

const TONE: Record<string, string> = {
  running: 'border-sky-400 bg-sky-50',
  error: 'border-red-400 bg-red-50',
  done: 'border-neutral-300 bg-white',
};

export function AgentCard({ data }: NodeProps<AgentFlowNode>) {
  const a = data.agent;
  const duration = a?.endedAt ? Date.parse(a.endedAt) - Date.parse(a.startedAt) : null;
  return (
    <div
      data-testid={`agent-node-${a?.id ?? 'main'}`}
      className={`w-[260px] rounded border p-2 text-xs shadow-sm ${TONE[a?.status ?? 'done'] ?? ''}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="truncate text-sm font-medium" title={data.label}>
        {data.label}
      </div>
      {a && (
        <>
          <div className="text-neutral-500">
            {a.agentType}
            {a.background ? ' · background' : ''}
            {data.step ? ` · ${data.step}` : ''}
          </div>
          <div>
            {a.status} · {formatTokens(a.usage.input + a.usage.output)} tok
            {a.usage.costUsd !== null ? ` · $${a.usage.costUsd.toFixed(2)}` : ''} ·{' '}
            {a.endedAt ? formatMs(duration) : 'running'}
          </div>
        </>
      )}
      {data.collapsed && <div className="text-neutral-500">+{data.childCount} hidden (double-click)</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
