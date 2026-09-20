import { HIDDEN_LABEL, type SessionListItem } from '@orc/api-contract';
import { Link } from '@tanstack/react-router';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import { usePinSession } from '@/api/queries/sessions.ts';
import { Badge, type BadgeVariant } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { formatCost, formatDateTime, formatDuration } from '@/lib/format.ts';
import { HideToggle, LabelEditor } from './LabelEditor.tsx';
import { Snippet } from './Snippet.tsx';

export const SESSION_ROW_HEIGHT = 64;
const GRID = 'grid grid-cols-[2.25rem_minmax(0,1fr)_8.5rem_4.5rem_4.5rem_13rem_11rem]';

const AVAILABILITY_VARIANT: Record<SessionListItem['availability'], BadgeVariant> = {
  resumable: 'success',
  archived: 'warning',
  'prompts-only': 'outline',
  remote: 'secondary',
};

function PinButton({ item }: { item: SessionListItem }) {
  const pin = usePinSession();
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={item.pinned ? 'Unpin' : 'Pin'}
      aria-pressed={item.pinned}
      onClick={() => pin.mutate({ source: item.source, id: item.id, pinned: !item.pinned })}
    >
      {item.pinned ? '★' : '☆'}
    </Button>
  );
}

function SessionCell({ item }: { item: SessionListItem }) {
  const title = item.name ?? item.firstPrompt ?? item.id;
  const secondary =
    item.recap ?? (item.lastPrompt && item.lastPrompt !== title ? item.lastPrompt : item.firstPrompt);
  return (
    <div className="flex min-w-0 flex-col py-1">
      <Link
        to="/sessions/$source/$id"
        params={{ source: item.source, id: item.id }}
        className="truncate font-medium hover:underline"
        title={title}
      >
        {title}
      </Link>
      <span className="truncate text-xs text-muted-foreground">
        {item.snippet ? <Snippet text={item.snippet} /> : (secondary ?? '')}
      </span>
    </div>
  );
}

function Chips({ item }: { item: SessionListItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1 overflow-hidden">
      <Badge variant={AVAILABILITY_VARIANT[item.availability]}>{item.availability}</Badge>
      {item.source !== 'claude' ? <Badge variant="secondary">{item.source}</Badge> : null}
      {item.live ? (
        <Badge variant="warning">{item.live.ownership === 'owned' ? 'open' : item.live.status}</Badge>
      ) : null}
      {item.tickets.slice(0, 2).map((t) => (
        <Badge key={t} variant="outline">
          {t}
        </Badge>
      ))}
      {item.prs.slice(0, 2).map((pr) => (
        <a
          key={pr.url}
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary underline"
        >
          #{pr.number}
        </a>
      ))}
      {item.labels
        .filter((l) => l !== HIDDEN_LABEL)
        .map((l) => (
          <Badge key={l} variant="secondary">
            {l}
          </Badge>
        ))}
    </div>
  );
}

function RowActions({ item }: { item: SessionListItem }) {
  return (
    <div className="flex items-center justify-end gap-1">
      <LabelEditor item={item} />
      <HideToggle item={item} />
    </div>
  );
}

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, SessionListItem>();
const columns = helper.columns([
  helper.display({
    id: 'pin',
    header: () => <span className="sr-only">Pinned</span>,
    cell: (info) => <PinButton item={info.row.original} />,
  }),
  helper.accessor('name', { header: 'Session', cell: (info) => <SessionCell item={info.row.original} /> }),
  helper.accessor('lastActivityAt', {
    header: 'Last activity',
    cell: (info) => formatDateTime(info.getValue()),
  }),
  helper.accessor('durationMs', { header: 'Duration', cell: (info) => formatDuration(info.getValue()) }),
  helper.accessor('costUsd', { header: 'Cost', cell: (info) => formatCost(info.getValue()) }),
  helper.display({ id: 'chips', header: 'Links', cell: (info) => <Chips item={info.row.original} /> }),
  helper.display({
    id: 'actions',
    header: () => <span className="sr-only">Actions</span>,
    cell: (info) => <RowActions item={info.row.original} />,
  }),
]);

export interface SessionTableProps {
  items: SessionListItem[];
  loading: boolean;
  error?: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onEndReached(): void;
}

export function SessionTable({
  items,
  loading,
  error = false,
  hasMore,
  loadingMore,
  onEndReached,
}: SessionTableProps) {
  const table = useTable({ features, columns, data: items, getRowId: (row) => row.pk });
  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const endReached = useRef(onEndReached);
  useEffect(() => {
    endReached.current = onEndReached;
  }, [onEndReached]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SESSION_ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => rows[index]?.id ?? index,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.at(-1)?.index ?? -1;
  useEffect(() => {
    if (hasMore && !loadingMore && rows.length > 0 && lastIndex >= rows.length - 5) endReached.current();
  }, [hasMore, loadingMore, lastIndex, rows.length]);

  if (loading) return <Skeleton className="h-64" />;
  if (rows.length === 0) {
    if (error) return null;
    return <p className="p-8 text-center text-sm text-muted-foreground">No sessions match these filters.</p>;
  }
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto rounded-md border">
      {/*
        display:grid overrides the implicit table/rowgroup/row/columnheader/cell roles in some
        browsers (notably Safari), so every role below is restored explicitly even though it
        matches Biome's a11y rules for what the native element already implies.
      */}
      {/* biome-ignore lint/a11y/noRedundantRoles: display:grid strips the implicit table role, see comment above */}
      <table role="table" className="grid w-full text-sm">
        {/* biome-ignore lint/a11y/noRedundantRoles: display:grid strips the implicit rowgroup role */}
        <thead role="rowgroup" className="sticky top-0 z-10 grid bg-background">
          {table.getHeaderGroups().map((group) => (
            // biome-ignore lint/a11y/noRedundantRoles: display:grid strips the implicit row role
            <tr key={group.id} role="row" className={`${GRID} border-b`}>
              {group.headers.map((header) => (
                // biome-ignore lint/a11y/useSemanticElements: scope="col" alone doesn't restore the role display:grid strips
                <th key={header.id} role="columnheader" className="px-2 py-1.5 text-left font-medium">
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        {/* biome-ignore lint/a11y/noRedundantRoles: display:grid strips the implicit rowgroup role */}
        <tbody role="rowgroup" className="relative grid" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((vi) => {
            const row = rows[vi.index];
            if (!row) return null;
            const rowStyle = { transform: `translateY(${vi.start}px)`, height: SESSION_ROW_HEIGHT };
            return (
              <tr
                key={row.id}
                // biome-ignore lint/a11y/noRedundantRoles: display:grid strips the implicit row role
                role="row"
                data-index={vi.index}
                className={`${GRID} absolute w-full items-center border-b`}
                style={rowStyle}
              >
                {row.getAllCells().map((cell) => (
                  // biome-ignore lint/a11y/noRedundantRoles: display:grid strips the implicit cell role
                  <td key={cell.id} role="cell" className="min-w-0 px-2">
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {loadingMore ? <p className="p-2 text-center text-xs text-muted-foreground">Loading more…</p> : null}
    </div>
  );
}
