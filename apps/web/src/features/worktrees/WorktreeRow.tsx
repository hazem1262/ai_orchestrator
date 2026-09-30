import type { WorktreeView } from '@orc/core';
import { Archive, Code2, FolderGit2, MoreHorizontal, Play, RefreshCw, SquareTerminal } from 'lucide-react';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { TableCell, TableRow } from '@/components/ui/table.tsx';

export type WorktreeAction = 'vscode' | 'terminal' | 'run' | 'sync' | 'archive';

const CHECKS_LABEL: Record<NonNullable<WorktreeView['prStatus']>['checks'], string> = {
  failure: 'checks failing',
  pending: 'checks running',
  success: 'checks passing',
  none: 'no checks',
};

export function prLabel(w: WorktreeView): string | null {
  const s = w.prStatus;
  if (!s) return w.prUrl ? 'PR' : null;
  if (s.state !== 'open') return `#${s.pr.number} · ${s.state}`;
  return `#${s.pr.number} · ${CHECKS_LABEL[s.checks]}`;
}

/** True once the worktree carries a PR link — desktop always shows a cell, phone omits it entirely. */
export function hasPr(w: WorktreeView): boolean {
  return Boolean(w.prStatus?.pr.url ?? w.prUrl);
}

type ActionHandler = (a: WorktreeAction, w: WorktreeView) => void;

function StateBadges({ w }: { w: WorktreeView }) {
  return (
    <>
      {w.isMain && <Badge variant="secondary">main checkout</Badge>}
      {!w.isMain && (
        <Badge variant={w.createdByApp ? 'default' : 'outline'}>{w.createdByApp ? 'app' : 'external'}</Badge>
      )}
      {w.dirty && <Badge variant="destructive">dirty</Badge>}
    </>
  );
}

function PrCell({ w }: { w: WorktreeView }) {
  const pr = prLabel(w);
  const prHref = w.prStatus?.pr.url ?? w.prUrl;
  return pr && prHref ? (
    <a href={prHref} target="_blank" rel="noreferrer" className="underline">
      {pr}
    </a>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

/** A repo group's display name: the GitHub `owner/name` when known, else the main checkout's folder name. */
export function repoGroupName(repo: string, rows: WorktreeView[]): string {
  return rows.find((w) => w.repoSlug)?.repoSlug ?? repo.split('/').filter(Boolean).at(-1) ?? repo;
}

/** The repo group's own header: a `heading` so screen readers can jump between groups, named with
 *  its worktree count, and the checkout path as a native tooltip. */
export function RepoGroupHeading({ repo, name, count }: { repo: string; name: string; count: number }) {
  return (
    <h2
      title={repo}
      aria-label={`${name}, ${count} worktree${count === 1 ? '' : 's'}`}
      className="flex min-w-0 items-center gap-1.5 truncate font-mono text-sm font-semibold text-muted-foreground"
    >
      <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
      <Badge variant="secondary" className="font-sans tabular-nums">
        {count}
      </Badge>
    </h2>
  );
}

/** IDE + Terminal are always one tap away; Run, Sync and Archive live behind one menu so the row
 *  never outgrows a phone. Archive still goes through the app's own confirm-before-destroy dialog
 *  (`GitConfirmDialog`, opened by the caller's mutation), which already asks the user before an
 *  archive proceeds, including the extra acknowledgement for a worktree the app didn't create. */
function Actions({ w, onAction }: { w: WorktreeView; onAction: ActionHandler }) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => onAction('vscode', w)}
        aria-label={`Open ${w.branch} in VS Code`}
      >
        <Code2 />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => onAction('terminal', w)}
        aria-label={`Open terminal in ${w.branch}`}
      >
        <SquareTerminal />
      </Button>
      {!w.isMain && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${w.branch}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem aria-label={`Run ${w.branch}`} onSelect={() => onAction('run', w)}>
              <Play />
              Run
            </DropdownMenuItem>
            <DropdownMenuItem
              aria-label={`Sync ${w.branch} to main checkout`}
              onSelect={() => onAction('sync', w)}
            >
              <RefreshCw />
              Sync to main checkout
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              aria-label={`Archive ${w.branch}`}
              onSelect={() => onAction('archive', w)}
            >
              <Archive />
              Archive…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function WorktreeRow({ w, onAction }: { w: WorktreeView; onAction: ActionHandler }) {
  return (
    <TableRow>
      <TableCell className="pl-3 font-mono">{w.branch}</TableCell>
      <TableCell>
        {w.ticket ? (
          <Badge variant="outline" className="font-mono">
            {w.ticket}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <span className="flex flex-wrap gap-1">
          <StateBadges w={w} />
        </span>
      </TableCell>
      <TableCell>
        <PrCell w={w} />
      </TableCell>
      <TableCell className="text-right font-mono text-xs tabular-nums">{w.sessionPks.length}</TableCell>
      <TableCell className="pr-3">
        <Actions w={w} onAction={onAction} />
      </TableCell>
    </TableRow>
  );
}

/** The phone layout of one worktree: the table row's fields stacked in a card. Empty fields (no
 *  ticket, no PR) are left out rather than printed as a dash, so a plain worktree stays a short
 *  card instead of a row of "—"s. */
export function WorktreeCard({ w, onAction }: { w: WorktreeView; onAction: ActionHandler }) {
  return (
    <article aria-label={w.branch} className="flex min-w-0 flex-col gap-1.5 rounded-lg border p-3 text-sm">
      <p className="truncate font-mono" title={w.branch}>
        {w.branch}
      </p>
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <StateBadges w={w} />
        {w.ticket ? <span>{w.ticket}</span> : null}
        {hasPr(w) ? (
          <span>
            PR <PrCell w={w} />
          </span>
        ) : null}
        <span>{`${w.sessionPks.length} sessions`}</span>
      </div>
      <div className="-ml-2 flex flex-wrap gap-1">
        <Actions w={w} onAction={onAction} />
      </div>
    </article>
  );
}
