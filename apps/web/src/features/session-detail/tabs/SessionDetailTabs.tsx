import type { Session } from '@orc/core';
import { useState } from 'react';
import { useSessionAgents } from '@/api/queries/session-detail.ts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { AgentsTree } from '../agents/AgentsTree.tsx';
import { ConductorChain } from '../agents/ConductorChain.tsx';
import { conductorChain, isConductorSession } from '../agents/conductor.ts';
import { TrajectoryTimeline } from '../timeline/TrajectoryTimeline.tsx';
import { FilesTab } from './FilesTab.tsx';
import { LinksTab } from './LinksTab.tsx';
import { RawTab } from './RawTab.tsx';
import { UsageTab } from './UsageTab.tsx';

export type DetailTab = 'timeline' | 'agents' | 'usage' | 'files' | 'links' | 'raw';
export const DETAIL_TABS: ReadonlyArray<{ id: DetailTab; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'agents', label: 'Agents' },
  { id: 'usage', label: 'Usage' },
  { id: 'files', label: 'Files' },
  { id: 'links', label: 'Links' },
  { id: 'raw', label: 'Raw' },
];

export interface DetailNavigation {
  tab?: DetailTab;
  agent?: string | null;
  file?: string | null;
}

interface Props {
  session: Session;
  tab: DetailTab;
  agentId: string | null;
  file: string | null;
  onNavigate: (n: DetailNavigation) => void;
}

const AGENT_VIEWS = [
  { id: 'tree', label: 'Tree' },
  { id: 'chain', label: 'Conductor chain' },
] as const;

const isDetailTab = (v: string): v is DetailTab => DETAIL_TABS.some((t) => t.id === v);

export function SessionDetailTabs({ session, tab, agentId, file, onNavigate }: Props) {
  const { source, id } = session;
  const agentsQ = useSessionAgents(source, id);
  const agents = agentsQ.data ?? [];
  const chain = conductorChain(agents, { isConductor: isConductorSession(session.skills) });
  const [agentView, setAgentView] = useState<'tree' | 'chain'>('tree');
  const currentAgent = agentId ? agents.find((a) => a.id === agentId) : undefined;

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        if (isDetailTab(v)) onNavigate({ tab: v });
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsList className="px-3">
        {DETAIL_TABS.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
            {t.id === 'agents' && agents.length > 0 ? ` (${agents.length})` : ''}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="timeline" className="min-h-0 flex-1 overflow-auto">
        {agentId && (
          <p className="flex items-center gap-2 px-3 pt-2 text-xs">
            <span>
              Subagent: {currentAgent ? currentAgent.description || currentAgent.agentType : agentId}
            </span>
            <button type="button" className="underline" onClick={() => onNavigate({ agent: null })}>
              Back to main session
            </button>
          </p>
        )}
        <TrajectoryTimeline
          source={source}
          id={id}
          agentId={agentId}
          onOpenFile={(path) => onNavigate({ tab: 'files', file: path })}
        />
      </TabsContent>
      <TabsContent value="agents" className="min-h-0 flex-1 overflow-auto">
        {chain && (
          <div role="radiogroup" aria-label="Agents view" className="flex gap-3 px-3 pt-2 text-xs">
            {AGENT_VIEWS.map((v) => (
              <label key={v.id} className="inline-flex cursor-pointer items-center gap-1">
                <input
                  type="radio"
                  name={`orc-agents-view-${source}-${id}`}
                  value={v.id}
                  checked={agentView === v.id}
                  onChange={() => setAgentView(v.id)}
                />
                {v.label}
              </label>
            ))}
          </div>
        )}
        {chain && agentView === 'chain' ? (
          <ConductorChain chain={chain} onOpenAgent={(a) => onNavigate({ tab: 'timeline', agent: a })} />
        ) : (
          <AgentsTree
            agents={agents}
            rootLabel={session.name ?? id}
            onOpenAgent={(a) => onNavigate({ tab: 'timeline', agent: a })}
          />
        )}
      </TabsContent>
      <TabsContent value="usage" className="min-h-0 flex-1 overflow-auto">
        <UsageTab source={source} id={id} />
      </TabsContent>
      <TabsContent value="files" className="min-h-0 flex-1 overflow-auto">
        <FilesTab
          source={source}
          id={id}
          startCwd={session.startCwd}
          selectedPath={file}
          onSelect={(p) => onNavigate({ file: p })}
        />
      </TabsContent>
      <TabsContent value="links" className="min-h-0 flex-1 overflow-auto">
        <LinksTab source={source} id={id} />
      </TabsContent>
      <TabsContent value="raw" className="min-h-0 flex-1 overflow-auto">
        <RawTab source={source} id={id} agents={agents} />
      </TabsContent>
    </Tabs>
  );
}
