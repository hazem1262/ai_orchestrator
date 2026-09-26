import type { WorktreeView } from '@orc/core';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';

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

export function WorktreeRow({
  w,
  onAction,
}: {
  w: WorktreeView;
  onAction: (a: WorktreeAction, w: WorktreeView) => void;
}) {
  const pr = prLabel(w);
  const prHref = w.prStatus?.pr.url ?? w.prUrl;
  return (
    <tr className="border-b text-sm">
      <td className="py-2 font-mono">{w.branch}</td>
      <td>{w.ticket ?? '—'}</td>
      <td className="space-x-1">
        {w.isMain && <Badge variant="secondary">main checkout</Badge>}
        {!w.isMain && (
          <Badge variant={w.createdByApp ? 'default' : 'outline'}>
            {w.createdByApp ? 'app' : 'external'}
          </Badge>
        )}
        {w.dirty && <Badge variant="destructive">dirty</Badge>}
      </td>
      <td>
        {pr && prHref ? (
          <a href={prHref} target="_blank" rel="noreferrer" className="underline">
            {pr}
          </a>
        ) : (
          (pr ?? '—')
        )}
      </td>
      <td>{w.sessionPks.length}</td>
      <td className="space-x-1 whitespace-nowrap text-right">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onAction('vscode', w)}
          aria-label={`Open ${w.branch} in VS Code`}
        >
          IDE
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onAction('terminal', w)}
          aria-label={`Open terminal in ${w.branch}`}
        >
          Terminal
        </Button>
        {!w.isMain && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onAction('run', w)}
              aria-label={`Run ${w.branch}`}
            >
              Run
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onAction('sync', w)}
              aria-label={`Sync ${w.branch} to main checkout`}
            >
              Sync
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onAction('archive', w)}
              aria-label={`Archive ${w.branch}`}
            >
              Archive
            </Button>
          </>
        )}
      </td>
    </tr>
  );
}
