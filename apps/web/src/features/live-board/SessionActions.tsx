import type { Session } from '@orc/core';
import { Link } from '@tanstack/react-router';
import { Copy, FileDiff, MoreHorizontal, Pin, PinOff, Square, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import { useKill } from '@/api/queries/launch.ts';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { useTerminalStore } from '@/stores/terminals.ts';
import { OpenInButton } from './OpenInButton.tsx';
import { resumeCommand } from './sort.ts';

export interface SessionActionsProps {
  session: Session;
  pinned: boolean;
  onTogglePin: () => void;
}

/** Card footer: Terminal, Details, Diff, the Open-in split button, and a menu for the rest. */
export function SessionActions({ session: s, pinned, onTogglePin }: SessionActionsProps) {
  const kill = useKill();
  const openTerminal = useTerminalStore((t) => t.open);
  const [confirmStop, setConfirmStop] = useState(false);
  const live = s.live;
  if (!live) return null;
  const title = s.name ?? s.id;
  const cwd = s.cwds.at(-1) ?? s.startCwd;
  const ptyId = live.ptyId;

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-1">
      {live.ownership === 'owned' && ptyId ? (
        <Button size="sm" onClick={() => openTerminal(ptyId, title)}>
          <SquareTerminal aria-hidden />
          Terminal
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" asChild>
        <Link to="/sessions/$source/$id" params={{ source: s.source, id: s.id }}>
          Details
        </Link>
      </Button>
      <Button size="sm" variant="ghost" asChild>
        <Link to="/review/$source/$id" params={{ source: s.source, id: s.id }}>
          <FileDiff aria-hidden />
          Diff
        </Link>
      </Button>
      <div className="ml-auto flex items-center gap-1">
        <OpenInButton session={s} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${title}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(resumeCommand(s))}>
              <Copy />
              Copy resume command
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onTogglePin}>
              {pinned ? <PinOff /> : <Pin />}
              {pinned ? 'Unpin from split' : 'Pin to split'}
            </DropdownMenuItem>
            {live.status === 'ended' ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmStop(true)}>
                  <Square />
                  Stop session…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Stop “${title}”?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {`Ends pid ${live.pid ?? '?'} in `}
              <code className="font-mono break-all">{cwd}</code>
              {'. Work the agent has not saved in this turn is lost.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => kill.mutate({ source: s.source, id: s.id })}
            >
              Stop session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
