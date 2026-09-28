import { Check, Clock, Copy, MoreHorizontal, RotateCcw, SquareTerminal, ThumbsUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { type InboxGroup, isTriageable, offersApprove, sessionRef } from './kinds.ts';
import { snoozePresets } from './snooze.ts';
import type { InboxTriage } from './useInboxTriage.ts';

export interface RowActionProps {
  group: InboxGroup;
  now: number;
  pty: string | null;
  triage: InboxTriage;
  onOpen(): void;
  onTerminal(ptyId: string): void;
}

function IconTip({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>
        {label}
        {hint ? <Kbd className="ml-1">{hint}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** The one Snooze control a row carries: a menu of the shared presets. */
export function SnoozeMenu({
  group,
  now,
  triage,
  presets,
  children,
}: {
  group: InboxGroup;
  now: number;
  triage: InboxTriage;
  /** Which presets to list; all of them by default. */
  presets?: (all: ReturnType<typeof snoozePresets>) => ReturnType<typeof snoozePresets>;
  children: ReactNode;
}) {
  const all = snoozePresets(new Date(now));
  const shown = presets ? presets(all) : all;
  return (
    <DropdownMenu>
      {children}
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
        {shown.map((p) => (
          <DropdownMenuItem key={p.label} onSelect={() => triage.snooze(group, p.until, p.label)}>
            {p.label}
            {p.label === all[0]?.label ? <DropdownMenuShortcut>S</DropdownMenuShortcut> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

async function copyReason(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied');
  } catch {
    toast.error('Could not copy to the clipboard');
  }
}

/** Open · Terminal · Done · Snooze · More — the desktop row's triage buttons. */
export function RowActions({ group, now, pty, triage, onOpen, onTerminal }: RowActionProps) {
  const item = group.lead;
  const ref = sessionRef(item);
  return (
    <div className="flex items-center justify-end gap-1">
      {ref ? (
        <Button size="sm" variant="outline" onClick={onOpen}>
          Open
        </Button>
      ) : null}
      {pty ? (
        <IconTip label="Open terminal">
          <Button size="icon-sm" variant="outline" aria-label="Terminal" onClick={() => onTerminal(pty)}>
            <SquareTerminal />
          </Button>
        </IconTip>
      ) : null}
      {isTriageable(item) ? (
        <>
          <IconTip label="Done" hint="e">
            <Button size="icon-sm" variant="ghost" aria-label="Mark done" onClick={() => triage.done(group)}>
              <Check />
            </Button>
          </IconTip>
          <SnoozeMenu group={group} now={now} triage={triage}>
            <IconTip label="Snooze" hint="s">
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Snooze">
                  <Clock />
                </Button>
              </DropdownMenuTrigger>
            </IconTip>
          </SnoozeMenu>
          <DropdownMenu>
            <IconTip label="More actions">
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
            </IconTip>
            <DropdownMenuContent align="end">
              {offersApprove(item) ? (
                <DropdownMenuItem disabled={triage.busy} onSelect={() => triage.approve(group)}>
                  <ThumbsUp />
                  Approve
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => void copyReason(item.reason)}>
                <Copy />
                Copy text
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => triage.reopen(group)}>
          <RotateCcw />
          Reopen
        </Button>
      )}
    </div>
  );
}
