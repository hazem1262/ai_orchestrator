import type { Session } from '@orc/core';
import { lazy, Suspense } from 'react';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty.tsx';
import { useTerminalStore } from '@/stores/terminals.ts';

// xterm is only needed once a session has an app-owned pty, so it loads on demand.
const TerminalView = lazy(() =>
  import('@/features/terminal/TerminalView.tsx').then((m) => ({ default: m.TerminalView })),
);

/**
 * The session's own pty, when the app owns one. The daemon lets several sockets attach to one pty,
 * so this view and the terminal dock can show the same session at once.
 */
export function TerminalTab({ session }: { session: Session }) {
  const open = useTerminalStore((s) => s.open);
  const live = session.live;
  const ptyId = live?.ownership === 'owned' ? live.ptyId : null;
  const title = session.name ?? session.firstPrompt ?? session.id;

  if (!ptyId) {
    const elsewhere = live?.ownership === 'observed' && live.status !== 'ended';
    return (
      <Empty className="rounded-lg border">
        <EmptyHeader>
          <EmptyTitle>No terminal in the app</EmptyTitle>
          <EmptyDescription>
            {elsewhere
              ? `This session runs in another terminal (pid ${live?.pid ?? '?'}). The app can only attach to terminals it started.`
              : 'Resume the session to open its terminal here.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{ptyId}</span>
        <Badge variant="outline">Owned by the app</Badge>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => open(ptyId, title)}>
          Open in dock
        </Button>
      </div>
      <div className="h-[60dvh] min-h-72 overflow-hidden rounded-lg border bg-terminal text-terminal-foreground">
        <Suspense fallback={<p className="p-2 text-xs text-terminal-foreground/60">Loading terminal…</p>}>
          <TerminalView ptyId={ptyId} active />
        </Suspense>
      </div>
    </div>
  );
}
