import type { AgentNode, Source } from '@orc/core';
import { useId, useState } from 'react';
import { useSessionRaw } from '@/api/queries/session-detail.ts';
import { Button } from '@/components/ui/button.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function RawTab({ source, id, agents }: { source: Source; id: string; agents: AgentNode[] }) {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const q = useSessionRaw(source, id, agentId);
  const selectId = useId();
  const lines = q.data?.pages.flatMap((p) => p.items) ?? [];

  const toggle = (offset: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(offset)) next.delete(offset);
      else next.add(offset);
      return next;
    });

  return (
    <div className="p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <label htmlFor={selectId}>Transcript</label>
        <NativeSelect
          id={selectId}
          value={agentId ?? ''}
          onChange={(e) => {
            setExpanded(new Set());
            setAgentId(e.target.value === '' ? null : e.target.value);
          }}
        >
          <option value="">main session</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.description || a.agentType}
            </option>
          ))}
        </NativeSelect>
      </div>
      {q.isError && <p role="alert">Raw transcript unavailable (archived or remote session).</p>}
      <ol className="space-y-1 font-mono">
        {lines.map((l) => (
          <li key={l.offset} className="border-b border-neutral-100">
            <button
              type="button"
              className="mr-2 text-neutral-400"
              onClick={() => toggle(l.offset)}
              aria-label={`Toggle line at ${l.offset}`}
            >
              {l.offset}
            </button>
            {l.partial && <span className="mr-1 rounded bg-amber-100 px-1">partial</span>}
            {l.truncated && <span className="mr-1 rounded bg-amber-100 px-1">truncated</span>}
            {expanded.has(l.offset) ? (
              <pre className="whitespace-pre-wrap">{pretty(l.text)}</pre>
            ) : (
              <span className="break-all">{l.text}</span>
            )}
          </li>
        ))}
      </ol>
      {q.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
