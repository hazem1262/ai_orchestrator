import type { Session } from '@orc/core';
import { useState } from 'react';
import { useSessionAgents } from '@/api/queries/session-detail.ts';
import { Button } from '@/components/ui/button.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { AgentsTree } from '../agents/AgentsTree.tsx';
import { ConductorChain } from '../agents/ConductorChain.tsx';
import { conductorChain, isConductorSession } from '../agents/conductor.ts';
import { TrajectoryTimeline } from '../timeline/TrajectoryTimeline.tsx';
import { ViewModeToggle } from '../timeline/ViewModeToggle.tsx';
import { DiffTab } from './DiffTab.tsx';
import { FilesTab } from './FilesTab.tsx';
import { LinksTab } from './LinksTab.tsx';
import { RawTab } from './RawTab.tsx';
import { TerminalTab } from './TerminalTab.tsx';
import { UsageTab } from './UsageTab.tsx';

export const DETAIL_TAB_IDS = [
  'timeline',
  'terminal',
  'diff',
  'files',
  'agents',
  'usage',
  'links',
  'raw',
] as const;
export type DetailTab = (typeof DETAIL_TAB_IDS)[number];
/** `timeline` keeps its URL value (`?tab=timeline`) so existing links still land on the transcript. */
export const DETAIL_TABS: ReadonlyArray<{ id: DetailTab; label: string }> = [
  { id: 'timeline', label: 'Transcript' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'diff', label: 'Diff' },
  { id: 'files', label: 'Files' },
  { id: 'agents', label: 'Agents' },
  { id: 'usage', label: 'Usage' },
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
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <TabsList variant="default">
          {DETAIL_TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="px-3">
              {t.label}
              {t.id === 'agents' && agents.length > 0 ? ` (${agents.length})` : ''}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value="timeline" className="flex h-[75dvh] min-h-96 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ViewModeToggle />
          {agentId && (
            <p className="flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate">
                Subagent: {currentAgent ? currentAgent.description || currentAgent.agentType : agentId}
              </span>
              <Button variant="link" size="xs" onClick={() => onNavigate({ agent: null })}>
                Back to main session
              </Button>
            </p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
          <TrajectoryTimeline
            source={source}
            id={id}
            agentId={agentId}
            onOpenFile={(path) => onNavigate({ tab: 'files', file: path })}
          />
        </div>
      </TabsContent>
      <TabsContent value="terminal">
        <TerminalTab session={session} />
      </TabsContent>
      <TabsContent value="diff">
        <DiffTab source={source} id={id} />
      </TabsContent>
      <TabsContent value="agents" className="overflow-auto">
        {chain && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            role="radiogroup"
            aria-label="Agents view"
            value={agentView}
            onValueChange={(v) => {
              if (v === 'tree' || v === 'chain') setAgentView(v);
            }}
            className="mb-2"
          >
            {AGENT_VIEWS.map((v) => (
              <ToggleGroupItem key={v.id} value={v.id}>
                {v.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
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
      <TabsContent value="usage" className="overflow-auto">
        <UsageTab source={source} id={id} />
      </TabsContent>
      <TabsContent value="files" className="overflow-auto">
        <FilesTab
          source={source}
          id={id}
          startCwd={session.startCwd}
          selectedPath={file}
          onSelect={(p) => onNavigate({ file: p })}
        />
      </TabsContent>
      <TabsContent value="links" className="overflow-auto">
        <LinksTab source={source} id={id} />
      </TabsContent>
      <TabsContent value="raw" className="overflow-auto">
        <RawTab source={source} id={id} agents={agents} />
      </TabsContent>
    </Tabs>
  );
}
