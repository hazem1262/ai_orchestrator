import { ApiRequestError, type ResumeRequest } from '@orc/api-contract';
import type { Availability, LiveState, Source } from '@orc/core';
import { useState } from 'react';
import { useResumeSession } from '@/api/queries/pty.ts';
import { Button } from '@/components/ui/button.tsx';
import { useTerminalStore } from '@/stores/terminals.ts';

export interface ResumeTarget {
  source: Source;
  id: string;
  availability: Availability;
  live: LiveState | null;
  title: string;
}

const SIZE = { cols: 120, rows: 36 };

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // clipboard permission denied: the command is still shown in the status line
  }
}

export function ResumeActions({ target, compact = false }: { target: ResumeTarget; compact?: boolean }) {
  const resume = useResumeSession();
  const open = useTerminalStore((s) => s.open);
  const close = useTerminalStore((s) => s.close);
  const [message, setMessage] = useState<string | null>(null);

  const live = target.live;
  const ownedPty = live?.ownership === 'owned' ? live.ptyId : null;
  const endedElsewhere = live?.ownership === 'observed' && live.status === 'ended';
  const runningElsewhere = live?.ownership === 'observed' && live.status !== 'ended';
  const unavailable = target.availability !== 'resumable' || resume.isPending;
  const title = target.title.length > 40 ? `${target.title.slice(0, 39)}…` : target.title;

  async function run(body: ResumeRequest, prefix: string | null): Promise<void> {
    setMessage(null);
    try {
      const r = await resume.mutateAsync({ source: target.source, id: target.id, body });
      if ('ptyId' in r) {
        open(r.ptyId, prefix ? `${prefix}: ${title}` : title);
        return;
      }
      if (ownedPty) close(ownedPty);
      await copyToClipboard(r.command);
      setMessage(`Opened outside the app. Command copied: ${r.command}`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'session_live') {
        const d = (err.details ?? {}) as { ptyId?: string; pid?: number | null };
        if (d.ptyId) {
          open(d.ptyId, title);
          setMessage('Already open in the app; switched to its terminal.');
          return;
        }
        setMessage(`Running in another terminal (pid ${d.pid ?? '?'}). Stop it there, then adopt it here.`);
        return;
      }
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
        {ownedPty ? (
          <Button size="sm" onClick={() => open(ownedPty, title)}>
            Show terminal
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={unavailable || runningElsewhere}
            title={target.availability !== 'resumable' ? `Not resumable (${target.availability})` : undefined}
            onClick={() => void run({ mode: 'embedded', ...SIZE }, null)}
          >
            {endedElsewhere ? 'Adopt' : 'Resume'}
          </Button>
        )}
        {compact ? null : (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={unavailable || target.source !== 'claude'}
              onClick={() => void run({ mode: 'embedded', fork: true, ...SIZE }, 'Fork')}
            >
              Fork
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={unavailable || runningElsewhere}
              onClick={() =>
                void run(ownedPty ? { mode: 'external', popOut: true } : { mode: 'external' }, null)
              }
            >
              Pop out
            </Button>
          </>
        )}
      </div>
      {runningElsewhere && !compact ? (
        <p className="text-xs text-warning">Running in another terminal (pid {live?.pid ?? '?'})</p>
      ) : null}
      {message ? (
        <p role="status" className="max-w-md text-right text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
