import { useEffect, useId, useState } from 'react';
import { useKillPty, usePtyList } from '@/api/queries/pty.ts';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/components/ui/cn.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import { TerminalView } from './TerminalView.tsx';

export function TerminalDock() {
  // `@/components/ui/tabs.tsx`'s <TabsContent> unmounts every non-active panel, which would kill
  // the pty socket and xterm instance of every background tab on each switch; tabs here must stay
  // mounted (just `hidden`) so their sessions keep streaming. So the tab strip is hand-rolled, but
  // wired with the same id/aria-controls/role="tabpanel"/aria-labelledby pattern as that primitive.
  const baseId = useId();
  const tabs = useTerminalStore((s) => s.tabs);
  const active = useTerminalStore((s) => s.active);
  const close = useTerminalStore((s) => s.close);
  const setActive = useTerminalStore((s) => s.setActive);
  const ptys = usePtyList();
  const kill = useKillPty();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!ptys.data) return;
    const ids = new Set(ptys.data.map((p) => p.id));
    for (const t of tabs) if (!ids.has(t.ptyId)) close(t.ptyId);
  }, [ptys.data, tabs, close]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arms the confirm step on tab switch
  useEffect(() => {
    setConfirming(false);
  }, [active]);

  if (tabs.length === 0) return null;
  const exited = new Set((ptys.data ?? []).filter((p) => p.exitedAt !== null).map((p) => p.id));

  return (
    <section aria-label="Terminals" className="flex h-full flex-col bg-[#0b0d10] text-white">
      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1 text-xs">
        <div role="tablist" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((t, i) => {
            const title = exited.has(t.ptyId) ? `${t.title} (exited)` : t.title;
            return (
              <div
                key={t.ptyId}
                className={cn('flex items-center rounded', t.ptyId === active && 'bg-white/10')}
              >
                <button
                  type="button"
                  role="tab"
                  id={`${baseId}-tab-${i}`}
                  aria-selected={t.ptyId === active}
                  aria-controls={`${baseId}-panel-${i}`}
                  onClick={() => setActive(t.ptyId)}
                  className="max-w-56 truncate px-2 py-1"
                >
                  {title}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${t.title}`}
                  onClick={() => close(t.ptyId)}
                  className="px-1 opacity-60 hover:opacity-100"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {active && !confirming ? (
          <Button size="sm" variant="ghost" className="text-white" onClick={() => setConfirming(true)}>
            Stop
          </Button>
        ) : null}
        {active && confirming ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => kill.mutate(active, { onSuccess: () => close(active) })}
            >
              Confirm stop
            </Button>
            <Button size="sm" variant="ghost" className="text-white" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.map((t, i) => (
          <div
            key={t.ptyId}
            id={`${baseId}-panel-${i}`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-${i}`}
            className="absolute inset-0"
            hidden={t.ptyId !== active}
          >
            <TerminalView ptyId={t.ptyId} active={t.ptyId === active} />
          </div>
        ))}
      </div>
    </section>
  );
}
