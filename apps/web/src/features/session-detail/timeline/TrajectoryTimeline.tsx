import type { DeliverableFile, Source, TurnStats } from '@orc/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessionDeliverables, useSessionStats } from '@/api/queries/session-detail.ts';
import { useSessionEvents } from '@/api/queries/sessions.ts';
import { useViewModeStore } from '@/stores/view-mode.ts';
import { DeliverablesRow } from './DeliverablesRow.tsx';
import { formatMs, inputSummary, statsSummary } from './format.ts';
import { buildTurnViews, type ToolStep, type TrajectoryItem, turnKey } from './group-events.ts';
import { StepInspector } from './StepInspector.tsx';
import { TurnStatsBar } from './TurnStatsBar.tsx';

interface Props {
  source: Source;
  id: string;
  agentId: string | null;
  onOpenFile: (path: string) => void;
}

const PROMPT_MAX = 300;

function ItemView({
  item,
  open,
  onToggle,
  onSelect,
}: {
  item: TrajectoryItem;
  open: boolean;
  onToggle: () => void;
  onSelect: (s: ToolStep) => void;
}) {
  switch (item.kind) {
    case 'text':
      return <p className="whitespace-pre-wrap">{item.event.text}</p>;
    case 'thinking':
      return <p className="whitespace-pre-wrap italic text-neutral-500">{item.event.text}</p>;
    case 'tool':
      return (
        <button type="button" className="font-mono text-xs" onClick={() => onSelect(item.step)}>
          {`${item.label}: ${inputSummary(item.step.call)}`}
        </button>
      );
    case 'tool_group':
      return (
        <div>
          <button type="button" aria-expanded={open} onClick={onToggle} className="font-mono text-xs">
            {`${item.label} ×${item.calls.length}`}
          </button>
          {open && (
            <ul className="ml-4">
              {item.calls.map((s) => (
                <li key={s.call.seq}>
                  <button type="button" className="font-mono text-xs" onClick={() => onSelect(s)}>
                    {inputSummary(s.call)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    case 'marker': {
      const e = item.event;
      if (e.kind === 'error') return <p className="text-red-600">API error: {e.text}</p>;
      if (e.durationMs !== null)
        return <p className="text-xs text-neutral-400">⏱ turn took {formatMs(e.durationMs)}</p>;
      return <p className="text-xs italic text-neutral-500">{e.text}</p>;
    }
  }
}

export function TrajectoryTimeline({ source, id, agentId, onOpenFile }: Props) {
  const mode = useViewModeStore((s) => s.mode);
  const events = useSessionEvents(source, id, agentId);
  const stats = useSessionStats(source, id);
  const deliverables = useSessionDeliverables(source, id);
  const [selected, setSelected] = useState<ToolStep | null>(null);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  const all = useMemo(() => events.data?.pages.flatMap((p) => p.items) ?? [], [events.data]);
  const turns = useMemo(() => buildTurnViews(all, mode), [all, mode]);
  const statsByKey = useMemo(() => {
    const m = new Map<string, TurnStats>();
    for (const t of stats.data?.turns ?? []) m.set(turnKey(t.agentId, t.turn), t);
    return m;
  }, [stats.data]);
  const delivByKey = useMemo(() => {
    const m = new Map<string, DeliverableFile[]>();
    for (const d of deliverables.data ?? []) m.set(turnKey(d.agentId, d.turn), d.files);
    return m;
  }, [deliverables.data]);
  const agentStats = agentId ? stats.data?.agents.find((a) => a.agentId === agentId)?.stats : undefined;
  const headerStats = agentId ? agentStats : stats.data?.session;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow.current && turns.length > 0) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const toggle = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (events.isLoading) return <p>Loading timeline…</p>;
  if (events.isError) return <p role="alert">Could not load the timeline.</p>;

  return (
    <div className="flex h-full min-h-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="timeline-scroll"
        className="min-w-0 flex-1 overflow-auto p-3"
      >
        {headerStats && (
          <p data-testid="session-stats" className="mb-3 text-xs text-neutral-600">
            {agentId ? 'Agent' : 'Session'}: {statsSummary(headerStats).join(' · ')}
          </p>
        )}
        {turns.map((t) => {
          const promptText = t.prompt?.text ?? (t.turn === 0 ? 'Agent start' : `Turn ${t.turn}`);
          return (
            <section
              key={t.key}
              aria-label={`Turn ${t.turn}`}
              className="mb-4 border-b border-neutral-100 pb-3"
            >
              <h3 title={promptText} className="font-medium">
                {promptText.length > PROMPT_MAX ? `${promptText.slice(0, PROMPT_MAX)}…` : promptText}
              </h3>
              <TurnStatsBar stats={statsByKey.get(t.key)} />
              {mode !== 'summary' && (
                <ol className="mt-2 space-y-1">
                  {t.items.map((item) => (
                    <li key={item.key}>
                      <ItemView
                        item={item}
                        open={openGroups.has(item.key)}
                        onToggle={() => toggle(item.key)}
                        onSelect={setSelected}
                      />
                    </li>
                  ))}
                </ol>
              )}
              <DeliverablesRow files={delivByKey.get(t.key) ?? []} onOpenFile={onOpenFile} />
            </section>
          );
        })}
        {events.hasNextPage && (
          <button
            type="button"
            disabled={events.isFetchingNextPage}
            onClick={() => void events.fetchNextPage()}
          >
            {events.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
      {selected && <StepInspector step={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
