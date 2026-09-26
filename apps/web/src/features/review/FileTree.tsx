import type { DiffFileEntry } from '@orc/core';
import { Checkbox } from '@/components/ui/checkbox.tsx';

const STATUS_MARK: Record<DiffFileEntry['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  binary: 'B',
};

export function FileTree(p: {
  files: DiffFileEntry[];
  selected: string | null;
  viewed: string[];
  onSelect(path: string): void;
  onToggleViewed(path: string): void;
}) {
  const viewedCount = p.viewed.filter((v) => p.files.some((f) => f.path === v)).length;
  return (
    <nav aria-label="Changed files" className="w-64 shrink-0 overflow-auto border-r text-sm">
      <p className="px-2 py-1 text-xs text-muted-foreground">
        {viewedCount}/{p.files.length} viewed
      </p>
      <ul>
        {p.files.map((f) => (
          <li
            key={f.path}
            className={`flex items-center gap-2 px-2 py-1 ${p.selected === f.path ? 'bg-muted' : ''}`}
          >
            <Checkbox
              aria-label={`Viewed ${f.path}`}
              checked={p.viewed.includes(f.path)}
              onCheckedChange={() => p.onToggleViewed(f.path)}
            />
            <span className="w-3 font-mono text-xs">{STATUS_MARK[f.status]}</span>
            <button
              type="button"
              className="flex-1 truncate text-left font-mono"
              onClick={() => p.onSelect(f.path)}
              title={f.path}
            >
              {f.path}
            </button>
            <span className="font-mono text-xs">{`+${f.additions} −${f.deletions}`}</span>
          </li>
        ))}
      </ul>
    </nav>
  );
}
