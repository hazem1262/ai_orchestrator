import type { WorktreeView } from '@orc/core';
import { useMemo, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { useDiscoverWorktrees, useWorktrees, worktreeKeys } from '@/api/queries/worktrees.ts';
import { Button } from '@/components/ui/button.tsx';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import { useIsMobile } from '@/features/mobile/useIsMobile.ts';
import { useProjectStore } from '@/stores/project.ts';
import { useTerminalStore } from '@/stores/terminals.ts';
import { CreateWorktreeDialog } from './CreateWorktreeDialog.tsx';
import { type WorktreeAction, WorktreeCard, WorktreeRow } from './WorktreeRow.tsx';

type ArchiveVars = { path: string; confirmExternal: boolean };

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
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Worktrees</h1>
        <Button size="sm" variant="outline" disabled={discover.isPending} onClick={() => discover.mutate()}>
          {discover.isPending ? 'Scanning…' : 'Discover'}
        </Button>
        <Button size="sm" onClick={() => setCreating(true)}>
          New worktree
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      {list.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {list.isSuccess && groups.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No worktrees yet. Discover scans the configured repositories.
        </p>
      )}
      {groups.map(([repo, rows]) => (
        <section key={repo} className="space-y-1">
          <h2 className="font-mono text-sm font-semibold break-all">{repo}</h2>
          {isMobile ? (
            <div className="flex flex-col gap-2">
              {rows.map((w) => (
                <WorktreeCard key={w.path} w={w} onAction={onAction} />
              ))}
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="font-medium">Branch</th>
                  <th className="font-medium">Ticket</th>
                  <th className="font-medium">State</th>
                  <th className="font-medium">PR</th>
                  <th className="font-medium">Sessions</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <WorktreeRow key={w.path} w={w} onAction={onAction} />
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
      <CreateWorktreeDialog
        open={creating}
        onClose={() => setCreating(false)}
        repos={(list.data ?? []).filter((w) => w.isMain).map((w) => w.path)}
      />
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
