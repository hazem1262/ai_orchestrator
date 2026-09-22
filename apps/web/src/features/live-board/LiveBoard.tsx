import type { Session } from '@orc/core';
import { useEffect, useMemo, useState } from 'react';
import { pkOf } from '@/api/live-events.ts';
import { scopeProject } from '@/api/queries/inbox.ts';
import { useLive } from '@/api/queries/live.ts';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { type LiveGroupBy, type LiveLayout, useLiveLayoutStore } from '@/stores/live-layout.ts';
import { useProjectStore } from '@/stores/project.ts';
import { SessionCard } from './SessionCard.tsx';
import { filterByProject, groupLive, sortLive } from './sort.ts';

const LAYOUTS: Array<{ id: LiveLayout; label: string }> = [
  { id: 'grid', label: 'Grid' },
  { id: 'list', label: 'List' },
  { id: 'split', label: 'Split' },
];

const GROUPS: Array<{ id: LiveGroupBy; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'project', label: 'Project' },
  { id: 'ticket', label: 'Ticket' },
  { id: 'source', label: 'Source' },
];

/** Time in state ticks every second; tests pass a fixed clock. */
function useNow(now?: () => number): number {
  const clock = now ?? Date.now;
  const [t, setT] = useState(clock);
  useEffect(() => {
    const id = setInterval(() => setT(clock()), 1000);
    return () => clearInterval(id);
  }, [clock]);
  return t;
}

export function LiveBoard({ now }: { now?: () => number }) {
  const { data, isLoading } = useLive();
  const projectId = scopeProject(useProjectStore((s) => s.projectId));
  const { layout, pinned, groupBy, setLayout, togglePin, setGroupBy } = useLiveLayoutStore();
  const t = useNow(now);

  const sessions = useMemo(() => sortLive(filterByProject(data ?? [], projectId)), [data, projectId]);
  const pinnedSessions = pinned
    .map((pk) => sessions.find((s) => pkOf(s) === pk))
    .filter((s): s is Session => s !== undefined);

  const card = (s: Session, compact = false) => (
    <SessionCard
      key={pkOf(s)}
      session={s}
      now={t}
      compact={compact}
      pinned={pinned.includes(pkOf(s))}
      onTogglePin={() => togglePin(pkOf(s))}
    />
  );

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-lg font-semibold">Live</h1>
        <div role="radiogroup" aria-label="Layout" className="flex gap-2 text-sm">
          {LAYOUTS.map((l) => (
            <label key={l.id} className="flex items-center gap-1">
              <input
                type="radio"
                name="live-layout"
                checked={layout === l.id}
                onChange={() => setLayout(l.id)}
              />
              {l.label}
            </label>
          ))}
        </div>
        <NativeSelect
          aria-label="Group by"
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as LiveGroupBy)}
        >
          {GROUPS.map((g) => (
            <option key={g.id} value={g.id}>
              {`Group by ${g.label.toLowerCase()}`}
            </option>
          ))}
        </NativeSelect>
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {!isLoading && sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No live sessions right now.</p>
      ) : null}

      {layout === 'split' ? (
        pinnedSessions.length < 2 ? (
          <p className="text-sm text-muted-foreground">Pin 2–4 sessions to compare them side by side.</p>
        ) : (
          <section
            aria-label="Split view"
            data-columns={pinnedSessions.length}
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(${pinnedSessions.length}, minmax(0, 1fr))` }}
          >
            {pinnedSessions.map((s) => card(s))}
          </section>
        )
      ) : (
        groupLive(sessions, groupBy).map((g) => {
          const body = (
            <div
              key={g.key}
              className={
                layout === 'grid' ? 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3' : 'flex flex-col gap-2'
              }
            >
              {g.sessions.map((s) => card(s, layout === 'list'))}
            </div>
          );
          return groupBy === 'none' ? (
            <div key={g.key}>{body}</div>
          ) : (
            <section key={g.key} aria-label={g.label} className="flex flex-col gap-2">
              <h2 className="text-sm font-medium text-muted-foreground">{g.label}</h2>
              {body}
            </section>
          );
        })
      )}
    </div>
  );
}
