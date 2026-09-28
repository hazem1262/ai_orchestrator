import type { WorktreeView } from '@orc/core';
import { GitBranch, ScanSearch } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { useDiscoverWorktrees, useWorktrees, worktreeKeys } from '@/api/queries/worktrees.ts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import { useIsMobile } from '@/features/mobile/useIsMobile.ts';
import { useProjectStore } from '@/stores/project.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import { CreateWorktreeDialog } from './CreateWorktreeDialog.tsx';
import { RepoGroupHeading, type WorktreeAction, WorktreeCard, WorktreeRow } from './WorktreeRow.tsx';

type ArchiveVars = { path: string; confirmExternal: boolean };

// Each row's width is its own key: it is fixed and unique across the four placeholder rows, so it
// never collides the way an array index would if a row were ever inserted or removed.
const SKELETON_ROW_WIDTHS = [55, 50, 45, 40];

function WorktreesSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading worktrees" className="divide-y rounded-xl border">
      {SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex items-center gap-4 px-3 py-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4" style={{ width: `${width}%` }} />
          </div>
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-7 w-24" />
        </div>
      ))}
    </div>
  );
}

export function WorktreesPage() {
  const projectId = useProjectStore((s) => s.projectId);
  const list = useWorktrees({ state: 'active', ...(projectId ? { projectId } : {}) });
  const discover = useDiscoverWorktrees();
  const openTerminal = useTerminalStore((s) => s.open);
  const [creating, setCreating] = useState(false);
  const isMobile = useIsMobile();

  const archive = useConfirmedMutation(
    (v: ArchiveVars, confirm: boolean) =>
      getApiClient().worktreesArchive({ path: v.path, confirm, confirmExternal: v.confirmExternal }),
    { invalidate: [worktreeKeys.all] },
  );
  const sync = useConfirmedMutation((v: { path: string }, confirm: boolean) =>
    getApiClient().worktreesSync({ path: v.path, confirm }),
  );
  const script = useConfirmedMutation(
    (v: { path: string; title: string }, confirm: boolean) =>
      getApiClient().worktreesScript({ path: v.path, which: 'run', confirm }),
    { onSuccess: (r, v) => openTerminal(r.ptyId, v.title) },
  );

  const groups = useMemo(() => {
    const byRepo = new Map<string, WorktreeView[]>();
    for (const w of list.data ?? []) byRepo.set(w.repo, [...(byRepo.get(w.repo) ?? []), w]);
    return [...byRepo.entries()];
  }, [list.data]);

  const onAction = (a: WorktreeAction, w: WorktreeView) => {
    switch (a) {
      case 'vscode':
      case 'terminal':
        void getApiClient().worktreesOpen({ path: w.path, target: a });
        return;
      case 'run':
        void script.run({ path: w.path, title: `run ${w.branch}` });
        return;
      case 'sync':
        void sync.run({ path: w.path });
        return;
      case 'archive':
        void archive.run({ path: w.path, confirmExternal: false });
        return;
    }
  };

  const error = archive.error ?? sync.error ?? script.error ?? list.error;
  const repos = (list.data ?? []).filter((w) => w.isMain).map((w) => w.path);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Worktrees</h1>
        <Button size="sm" variant="outline" disabled={discover.isPending} onClick={() => discover.mutate()}>
          <ScanSearch />
          {discover.isPending ? 'Scanning…' : 'Discover'}
        </Button>
        <Button size="sm" onClick={() => setCreating(true)}>
          New worktree
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Couldn't run that action</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {list.isLoading ? (
        <WorktreesSkeleton />
      ) : list.isSuccess && groups.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitBranch aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No worktrees yet</EmptyTitle>
            <EmptyDescription>
              Discover scans the configured repositories and the folders your sessions ran in.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" disabled={discover.isPending} onClick={() => discover.mutate()}>
              <ScanSearch />
              {discover.isPending ? 'Scanning…' : 'Discover'}
            </Button>
          </EmptyContent>
        </Empty>
      ) : !list.isSuccess ? null : isMobile ? (
        <div className="flex flex-col gap-4">
          {groups.map(([repo, rows]) => (
            <section key={repo} aria-label={repo} className="flex min-w-0 flex-col gap-2">
              <RepoGroupHeading repo={repo} />
              <div className="flex flex-col gap-2">
                {rows.map((w) => (
                  <WorktreeCard key={w.path} w={w} onAction={onAction} />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border">
          <Table aria-label="Worktrees" className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-3">Branch</TableHead>
                <TableHead className="w-28">Ticket</TableHead>
                <TableHead className="w-48">State</TableHead>
                <TableHead className="w-32">PR</TableHead>
                <TableHead className="w-24 text-right">Sessions</TableHead>
                <TableHead className="w-32 pr-3 xl:w-44">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map(([repo, rows]) => (
                <Fragment key={repo}>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableCell colSpan={6} className="py-1.5 pl-3">
                      <RepoGroupHeading repo={repo} />
                    </TableCell>
                  </TableRow>
                  {rows.map((w) => (
                    <WorktreeRow key={w.path} w={w} onAction={onAction} />
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateWorktreeDialog open={creating} onClose={() => setCreating(false)} repos={repos} />
      <GitConfirmDialog
        request={archive.pending}
        busy={archive.busy}
        title="Archive worktree?"
        confirmLabel="Archive"
        danger
        onConfirm={(p) => void archive.confirm(p)}
        onCancel={archive.cancel}
      />
      <GitConfirmDialog
        request={sync.pending}
        busy={sync.busy}
        title="Sync to main checkout?"
        confirmLabel="Copy files"
        onConfirm={() => void sync.confirm()}
        onCancel={sync.cancel}
      />
      <GitConfirmDialog
        request={script.pending}
        busy={script.busy}
        title="Run script?"
        confirmLabel="Run"
        onConfirm={() => void script.confirm()}
        onCancel={script.cancel}
      />
    </div>
  );
}
