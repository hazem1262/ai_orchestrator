import type { Source } from '@orc/core';
import { useMemo, useState } from 'react';
import { useSessionEvents } from '@/api/queries/sessions.ts';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/components/ui/cn.ts';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { formatDuration } from '@/lib/format.ts';
import { groupTimeline, inputPreview, type TimelineItem, type TurnGroup } from './timeline-model.ts';

/** Above this, a tool result or compact-summary body (a 60 KB compact summary is real, measured)
 *  is shown truncated behind a real "show more" toggle rather than laid out in full. */
const TEXT_TRUNCATE_AT = 4000;

function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > TEXT_TRUNCATE_AT;
  const shown = expanded || !long ? text : `${text.slice(0, TEXT_TRUNCATE_AT)}…`;
  return (
    <div className="flex flex-col gap-1">
      <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{shown}</pre>
      {long ? (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="self-start"
        >
          {expanded ? 'Show less' : `Show all (${text.length.toLocaleString()} chars)`}
        </Button>
      ) : null}
    </div>
  );
}

function EventView({ item }: { item: Extract<TimelineItem, { type: 'event' }> }) {
  const e = item.event;
  if (e.kind === 'system' && e.tool === 'turn_duration') {
    return <p className="text-xs text-muted-foreground">Turn took {formatDuration(e.durationMs)}</p>;
  }
  if (e.kind === 'system' && e.tool === 'away_summary') {
    return <p className="rounded bg-muted px-2 py-1 text-sm">Recap: {e.text}</p>;
  }
  if (e.kind === 'system' && e.tool === 'command') {
    return <p className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">$ {e.text}</p>;
  }
  if (e.kind === 'system' && e.tool === 'compact_summary') {
    return (
      <div className="flex flex-col gap-1 rounded border px-2 py-1">
        <p className="text-xs font-medium text-muted-foreground">Compacted</p>
        <ExpandableText text={e.text ?? ''} />
      </div>
    );
  }
  if (e.kind === 'error') {
    return <p className="text-sm text-destructive">API error: {e.text}</p>;
  }
  if (e.kind === 'tool_result') {
    return <ExpandableText text={e.text ?? ''} />;
  }
  if (e.kind === 'system') {
    return <p className="text-xs text-muted-foreground">{e.text ?? e.tool}</p>;
  }
  return <p className="text-sm whitespace-pre-wrap">{e.text}</p>;
}

function ToolsView({ item }: { item: Extract<TimelineItem, { type: 'tools' }> }) {
  return (
    <details className="rounded border px-2 py-1">
      <summary className="cursor-pointer text-sm font-medium">
        {item.label} ×{item.calls.length}
      </summary>
      <ul className="mt-1 flex flex-col gap-2">
        {item.calls.map(({ call, result }) => (
          <li key={call.seq} className="flex flex-col gap-1">
            <code className="text-xs">{inputPreview(call.input)}</code>
            {result ? <ExpandableText text={result.text ?? ''} /> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function TurnSection({ turn }: { turn: TurnGroup }) {
  return (
    <li className="rounded-lg border">
      <details open>
        <summary className="cursor-pointer bg-muted px-3 py-2 text-sm">
          {turn.prompt ? (
            <>
              <span className="mr-2 text-muted-foreground">#{turn.turn}</span>
              <span className="font-medium whitespace-pre-wrap">{turn.prompt.text}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Before the first prompt</span>
          )}
        </summary>
        <ul className="flex flex-col gap-2 p-3">
          {turn.items.map((item) => (
            <li key={item.key}>
              {item.type === 'tools' ? <ToolsView item={item} /> : <EventView item={item} />}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

export function Timeline({ source, id }: { source: Source; id: string }) {
  const q = useSessionEvents(source, id, null);
  const turns = useMemo(() => groupTimeline(q.data?.pages.flatMap((p) => p.items) ?? []), [q.data]);
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError) {
    return (
      <div className={cn('flex items-center justify-between gap-3')}>
        <p role="alert" className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : 'Failed to load the timeline.'}
        </p>
        <Button
          variant="outline"
          size="sm"
          aria-label="Retry timeline"
          disabled={q.isFetching}
          onClick={() => void q.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (turns.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No transcript events. This session only exists in prompt history (or its transcript has not been
        indexed yet).
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Timeline" className="flex flex-col gap-3">
        {turns.map((t) => (
          <TurnSection key={`turn-${t.turn}`} turn={t} />
        ))}
      </ol>
      {q.hasNextPage ? (
        <Button variant="outline" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
}
