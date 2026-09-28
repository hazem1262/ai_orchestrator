import type { SessionListItem } from '@orc/api-contract';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { History as HistoryIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { useIsMobile } from '@/features/mobile/useIsMobile.ts';
import { formatCost, formatDateTime, formatDuration } from '@/lib/format.ts';
import { Chips, PinButton, SessionSecondary, SessionTitle } from './parts.tsx';
import { RowActions } from './RowActions.tsx';
import { SessionCards } from './SessionCards.tsx';

export const SESSION_ROW_HEIGHT = 64;
// The row grid is CSS grid, not a native table layout, so react-virtual can absolutely position
// rows by translateY. Below `lg` the Links and Duration columns drop out (audit F8 column priority).
const GRID =
  'grid grid-cols-[2.25rem_minmax(0,1fr)_7rem_5rem_9rem] lg:grid-cols-[2.25rem_minmax(0,1fr)_13rem_7rem_5rem_5rem_9rem]';
const LG_ONLY = new Set(['chips', 'durationMs']);
const priorityClass = (columnId: string) => (LG_ONLY.has(columnId) ? ' max-lg:hidden' : '');

function SessionCell({ item }: { item: SessionListItem }) {
  return (
    <div className="flex min-w-0 flex-col py-1">
      <SessionTitle item={item} className="truncate" />
      <SessionSecondary item={item} />
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
  helper.display({ id: 'chips', header: 'Links', cell: (info) => <Chips item={info.row.original} /> }),
  helper.accessor('lastActivityAt', {
    header: 'Last activity',
    cell: (info) => formatDateTime(info.getValue()),
  }),
  helper.accessor('durationMs', { header: 'Duration', cell: (info) => formatDuration(info.getValue()) }),
  helper.accessor('costUsd', { header: 'Cost', cell: (info) => formatCost(info.getValue()) }),
  helper.display({
    id: 'actions',
    header: () => <span className="sr-only">Actions</span>,
    cell: (info) => <RowActions item={info.row.original} />,
  }),
]);

function TableSkeleton() {
  const rows = Array.from({ length: 6 }, (_, i) => i);
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading sessions"
      className="flex flex-col gap-2 rounded-xl border p-2"
    >
      {rows.map((i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-2">
          <Skeleton className="size-6 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4" style={{ width: `${70 - i * 5}%` }} />
            <Skeleton className="h-3 w-2/5" />
          </div>
          <Skeleton className="h-3 w-16 max-lg:hidden" />
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-7 w-20" />
        </div>
      ))}
    </div>
  );
}

function EmptyRows() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HistoryIcon />
        </EmptyMedia>
        <EmptyTitle>No sessions match these filters.</EmptyTitle>
        <EmptyDescription>Try a shorter search, or clear the filters above.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function VirtualizedTable({ items, hasMore, loadingMore, onEndReached }: SessionTableProps) {
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

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto rounded-xl border">
      {/*
        display:grid overrides the implicit table/rowgroup/row/columnheader/cell roles in some
        browsers (notably Safari), so every role below is restored explicitly even though it
        matches Biome's a11y rules for what the native element already implies.
      */}
      {/* biome-ignore lint/a11y/noRedundantRoles: display:grid strips the implicit table role, see comment above */}
      <table role="table" aria-label="Sessions" className="grid w-full text-sm">
        {/* biome-ignore lint/a11y/noRedundantRoles: display:grid strips the implicit rowgroup role */}
        <thead role="rowgroup" className="sticky top-0 z-10 grid bg-background">
          {table.getHeaderGroups().map((group) => (
            // biome-ignore lint/a11y/noRedundantRoles: display:grid strips the implicit row role
            <tr key={group.id} role="row" className={`${GRID} border-b`}>
              {group.headers.map((header) => (
                // biome-ignore lint/a11y/useSemanticElements: scope="col" alone doesn't restore the role display:grid strips
                <th
                  key={header.id}
                  role="columnheader"
                  className={`h-9 px-2 text-left align-middle font-medium text-foreground${priorityClass(header.column.id)}`}
                >
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
                className={`${GRID} absolute w-full items-center border-b transition-colors hover:bg-muted/50`}
                style={rowStyle}
              >
                {row.getAllCells().map((cell) => (
                  // biome-ignore lint/a11y/noRedundantRoles: display:grid strips the implicit cell role
                  <td key={cell.id} role="cell" className={`min-w-0 px-2${priorityClass(cell.column.id)}`}>
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
  const isMobile = useIsMobile();

  if (loading) return <TableSkeleton />;
  if (items.length === 0) {
    if (error) return null;
    return <EmptyRows />;
  }
  if (isMobile) {
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <SessionCards items={items} />
        {loadingMore ? <p className="p-2 text-center text-xs text-muted-foreground">Loading more…</p> : null}
      </div>
    );
  }
  return (
    <VirtualizedTable
      items={items}
      loading={loading}
      error={error}
      hasMore={hasMore}
      loadingMore={loadingMore}
      onEndReached={onEndReached}
    />
  );
}
