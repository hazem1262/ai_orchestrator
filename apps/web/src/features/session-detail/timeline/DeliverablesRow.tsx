import type { DeliverableFile } from '@orc/core';
import { shortPath } from './format.ts';

const MARK: Record<DeliverableFile['status'], string> = { applied: '', failed: ' ✗', pending: ' …' };
const TONE: Record<DeliverableFile['status'], string> = {
  applied: 'border-success/40 bg-success/10',
  failed: 'border-destructive/40 bg-destructive/10 line-through',
  pending: 'border-warning/40 bg-warning/10',
};

export function DeliverablesRow({
  files,
  onOpenFile,
}: {
  files: DeliverableFile[];
  onOpenFile: (path: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <ul aria-label="Deliverables" className="mt-2 flex flex-wrap gap-1">
      {files.map((f) => (
        <li key={f.path}>
          <button
            type="button"
            onClick={() => onOpenFile(f.path)}
            title={`${f.path} — ${f.tools.join(', ')} ×${f.ops} — ${f.status}`}
            className={`rounded border px-2 py-0.5 font-mono text-xs ${TONE[f.status]}`}
          >
            {shortPath(f.path)}
            {MARK[f.status]}
          </button>
        </li>
      ))}
    </ul>
  );
}
