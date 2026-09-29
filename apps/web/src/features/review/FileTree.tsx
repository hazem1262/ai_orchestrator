import type { DiffFileEntry } from '@orc/core';
import { Card, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';

const STATUS_MARK: Record<DiffFileEntry['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  binary: 'B',
};

const STATUS_TONE: Record<DiffFileEntry['status'], string> = {
  added: 'text-success',
  modified: 'text-info',
  deleted: 'text-destructive',
  renamed: 'text-warning',
  binary: 'text-muted-foreground',
};

export function FileTree(p: {
  files: DiffFileEntry[];
  selected: string | null;
  viewed: string[];
  onSelect(path: string): void;
  onToggleViewed(path: string): void;
}) {
  const viewedCount = p.viewed.filter((v) => p.files.some((f) => f.path === v)).length;
  const pct = p.files.length ? (viewedCount / p.files.length) * 100 : 0;
  return (
    <Card className="w-64 shrink-0 overflow-auto">
      <CardHeader className="gap-1.5 p-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          Files
          <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
            {viewedCount}/{p.files.length} viewed
          </span>
        </CardTitle>
        <div
          role="progressbar"
          aria-label={`${viewedCount} of ${p.files.length} files viewed`}
          aria-valuenow={viewedCount}
          aria-valuemin={0}
          aria-valuemax={p.files.length}
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </CardHeader>
      <nav aria-label="Changed files" className="border-t text-sm">
        <ul>
          {p.files.map((f) => (
            <li
              key={f.path}
              className={`flex items-center gap-2 px-2 py-1 ${p.selected === f.path ? 'bg-accent text-accent-foreground' : ''}`}
            >
              <Checkbox
                aria-label={`Viewed ${f.path}`}
                checked={p.viewed.includes(f.path)}
                onCheckedChange={() => p.onToggleViewed(f.path)}
              />
              <span className={`w-3 font-mono text-xs font-semibold ${STATUS_TONE[f.status]}`}>
                {STATUS_MARK[f.status]}
              </span>
              <button
                type="button"
                className={`flex-1 truncate text-left font-mono ${p.viewed.includes(f.path) && p.selected !== f.path ? 'opacity-60' : ''}`}
                onClick={() => p.onSelect(f.path)}
                title={f.path}
              >
                {f.path}
              </button>
              <span className="font-mono text-xs">
                <span className="text-success">+{f.additions}</span>{' '}
                <span className="text-destructive">−{f.deletions}</span>
              </span>
            </li>
          ))}
        </ul>
      </nav>
    </Card>
  );
}
