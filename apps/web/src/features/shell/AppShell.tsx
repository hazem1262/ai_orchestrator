import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, lazy, type ReactNode, Suspense, useState } from 'react';
import { Group, Panel, Separator as PanelSeparator } from 'react-resizable-panels';
import { useLiveEvents } from '@/api/live-events.ts';
import { scopeProject, useOpenInboxCount } from '@/api/queries/inbox.ts';
import { Input } from '@/components/ui/input.tsx';
import { useInboxTitle } from '@/features/inbox/useInboxTitle.ts';
import { useProjectStore } from '@/stores/project.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import { ProjectSelector } from './ProjectSelector.tsx';

// xterm.js is sizeable and only ever used once a terminal tab is open, so it's kept out of the
// main bundle (and every route that never opens one) behind a dynamic import.
const TerminalDock = lazy(() =>
  import('@/features/terminal/TerminalDock.tsx').then((m) => ({ default: m.TerminalDock })),
);

function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void navigate({ to: '/history', search: q.trim() ? { q: q.trim() } : {} });
  };
  return (
    <form onSubmit={submit} className="w-72">
      <Input
        type="search"
        aria-label="Search all sessions"
        placeholder="Search sessions…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="w-full"
      />
    </form>
  );
}

function Workspace({ children }: { children: ReactNode }) {
  const hasTabs = useTerminalStore((s) => s.tabs.length > 0);
  return (
    <Group orientation="vertical" className="min-w-0 flex-1">
      <Panel id="main" minSize="20">
        <main className="h-full overflow-auto">{children}</main>
      </Panel>
      {hasTabs ? (
        <>
          <PanelSeparator className="h-1 cursor-row-resize bg-border" />
          <Panel id="dock" defaultSize="40" minSize="10">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center bg-[#0b0d10] text-xs text-white/60">
                  Loading terminal…
                </div>
              }
            >
              <TerminalDock />
            </Suspense>
          </Panel>
        </>
      ) : null}
    </Group>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  // One socket for the whole app: the shell outlives every route, so the live caches stay fresh
  // across navigation and a reconnect resyncs them once.
  useLiveEvents();
  const projectId = scopeProject(useProjectStore((s) => s.projectId));
  useInboxTitle(useOpenInboxCount(projectId));
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b px-4">
        <Link to="/history" className="font-semibold">
          Orchestrator
        </Link>
        <ProjectSelector />
        <GlobalSearch />
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Main" className="flex w-40 shrink-0 flex-col gap-1 border-r p-2 text-sm">
          <Link
            to="/history"
            className="rounded px-2 py-1 hover:bg-muted"
            activeProps={{ className: 'bg-muted font-medium' }}
          >
            History
          </Link>
          <Link
            to="/settings"
            className="rounded px-2 py-1 hover:bg-muted"
            activeProps={{ className: 'bg-muted font-medium' }}
          >
            Settings
          </Link>
        </nav>
        <Workspace>{children}</Workspace>
      </div>
    </div>
  );
}
