import type { Source } from '@orc/core';
import { useSessionFiles } from '@/api/queries/session-detail.ts';
import { Button } from '@/components/ui/button.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';

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
    return (
      <p className="p-3 text-sm text-muted-foreground">No files were edited by tools in this session.</p>
    );
  const selected = files.find((f) => f.path === selectedPath) ?? null;

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Table className="self-start">
        <TableHeader>
          <TableRow className="text-xs">
            <TableHead>File</TableHead>
            <TableHead>Edits</TableHead>
            <TableHead>Failed</TableHead>
            <TableHead>Turns</TableHead>
            <TableHead>Agents</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((f) => (
            <TableRow key={f.path} data-state={f.path === selectedPath ? 'selected' : undefined}>
              <TableCell>
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto p-0 font-mono text-foreground underline"
                  title={f.path}
                  onClick={() => onSelect(f.path)}
                >
                  {rel(f.path, startCwd)}
                </Button>
              </TableCell>
              <TableCell>{f.ops}</TableCell>
              <TableCell>{f.failedOps}</TableCell>
              <TableCell>{f.turns.join(', ')}</TableCell>
              <TableCell>{f.agentIds.map((a) => a ?? 'main').join(', ')}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {selected && (
        <section aria-label="File changes" className="text-xs">
          <h3 className="mb-1 font-mono">{selected.path}</h3>
          <p className="mb-2 text-muted-foreground">
            Tool-level edit snippets. The full diff view arrives with Review &amp; Merge (Phase 4).
          </p>
          {selected.changes.map((c) => (
            <article
              key={`${c.agentId ?? 'main'}-${c.seq}-${c.path}`}
              className="mb-3 rounded border border-border p-2"
            >
              <header className="mb-1">
                turn {c.turn} · {c.tool} · {c.status} · {new Date(c.ts).toLocaleTimeString()}
              </header>
              {c.oldText !== null && (
                <pre data-testid="change-old" className="whitespace-pre-wrap bg-destructive/10 p-1">
                  {c.oldText}
                </pre>
              )}
              {c.newText !== null && (
                <pre data-testid="change-new" className="whitespace-pre-wrap bg-success/10 p-1">
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
