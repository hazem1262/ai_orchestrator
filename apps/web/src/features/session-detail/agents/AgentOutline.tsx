import type { AgentNode } from '@orc/core';
import { childrenIndex, ROOT_ID } from './layout.ts';

interface Props {
  agents: AgentNode[];
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpenAgent: (id: string) => void;
}

export function AgentOutline({ agents, collapsed, onToggle, onOpenAgent }: Props) {
  const kids = childrenIndex(agents);
  const renderLevel = (parent: string) => (
    <ul role="none" className="ml-4">
      {(kids.get(parent) ?? []).map((a) => {
        const label = a.description || a.agentType;
        const children = kids.get(a.id) ?? [];
        const isCollapsed = collapsed.has(a.id);
        return (
          <li
            key={a.id}
            role="treeitem"
            tabIndex={-1}
            aria-expanded={children.length ? !isCollapsed : undefined}
            aria-selected={false}
          >
            {children.length > 0 && (
              <button
                type="button"
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${label}`}
                onClick={() => onToggle(a.id)}
              >
                {isCollapsed ? '▸' : '▾'}
              </button>
            )}
            <button
              type="button"
              aria-label={`Open ${label}`}
              onClick={() => onOpenAgent(a.id)}
              className="ml-1"
            >
              {label}
            </button>
            <span className="ml-2 text-xs text-neutral-500">{a.status}</span>
            {children.length > 0 && !isCollapsed && renderLevel(a.id)}
          </li>
        );
      })}
    </ul>
  );
  return (
    <div role="tree" aria-label="Agents outline" className="text-sm">
      {renderLevel(ROOT_ID)}
    </div>
  );
}
