import type { Source } from '@orc/core';
import { useSessionFiles } from '@/api/queries/session-detail.ts';

interface Props {
  source: Source;
  id: string;
  startCwd: string;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}

const rel = (p: string, cwd: string) => (p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);

export function FilesTab({ source, id, startCwd, selectedPath, onSelect }: Props) {
  const q = useSessionFiles(source, id);
  if (q.isLoading) return <p className="p-3">Loading files…</p>;
  if (q.isError)
    return (
      <p role="alert" className="p-3">
        Could not load files.
      </p>
    );
  const files = q.data ?? [];
  if (files.length === 0)
    return <p className="p-3 text-sm text-neutral-500">No files were edited by tools in this session.</p>;
  const selected = files.find((f) => f.path === selectedPath) ?? null;

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <table className="w-full self-start text-sm">
        <thead>
          <tr className="text-left text-xs text-neutral-500">
            <th>File</th>
            <th>Edits</th>
            <th>Failed</th>
            <th>Turns</th>
            <th>Agents</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.path} className={f.path === selectedPath ? 'bg-neutral-100' : ''}>
              <td>
                <button
                  type="button"
                  className="font-mono text-xs underline"
                  title={f.path}
                  onClick={() => onSelect(f.path)}
                >
                  {rel(f.path, startCwd)}
                </button>
              </td>
              <td>{f.ops}</td>
              <td>{f.failedOps}</td>
              <td>{f.turns.join(', ')}</td>
              <td>{f.agentIds.map((a) => a ?? 'main').join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && (
        <section aria-label="File changes" className="text-xs">
          <h3 className="mb-1 font-mono">{selected.path}</h3>
          <p className="mb-2 text-neutral-500">
            Tool-level edit snippets. The full diff view arrives with Review &amp; Merge (Phase 4).
          </p>
          {selected.changes.map((c) => (
            <article
              key={`${c.agentId ?? 'main'}-${c.seq}-${c.path}`}
              className="mb-3 rounded border border-neutral-200 p-2"
            >
              <header className="mb-1">
                turn {c.turn} · {c.tool} · {c.status} · {new Date(c.ts).toLocaleTimeString()}
              </header>
              {c.oldText !== null && (
                <pre data-testid="change-old" className="whitespace-pre-wrap bg-red-50 p-1">
                  {c.oldText}
                </pre>
              )}
              {c.newText !== null && (
                <pre data-testid="change-new" className="whitespace-pre-wrap bg-emerald-50 p-1">
                  {c.newText}
                </pre>
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
