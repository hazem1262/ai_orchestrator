import type { SessionListItem } from '@orc/api-contract';
import { useCallback, useMemo } from 'react';
import { useSessions } from '@/api/queries/sessions.ts';
import { Button } from '@/components/ui/button.tsx';
import { useProjectStore } from '@/stores/project.ts';
import { cleanSearch, type HistorySearch, toListFilters } from './filters.ts';
import { HistoryFilters } from './HistoryFilters.tsx';
import { SavedViews } from './SavedViews.tsx';
import { SessionTable } from './SessionTable.tsx';

const NO_ITEMS: SessionListItem[] = [];

export function HistoryPage({
  search,
  onSearchChange,
}: {
  search: HistorySearch;
  onSearchChange(next: HistorySearch): void;
}) {
  const projectId = useProjectStore((s) => s.projectId);
  const filters = useMemo(() => toListFilters(search, projectId), [search, projectId]);
  const q = useSessions(filters);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? NO_ITEMS, [q.data]);
  const { fetchNextPage } = q;
  const loadMore = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">History</h1>
        <SavedViews search={search} onApply={(s) => onSearchChange(cleanSearch(s))} />
      </div>
      <HistoryFilters
        search={search}
        onChange={(patch) => onSearchChange(cleanSearch({ ...search, ...patch }))}
        onReset={() => onSearchChange({})}
      />
      {q.isError ? (
        <div className="flex items-center justify-between gap-3">
          <p role="alert" className="text-sm text-destructive">
            {q.error.message}
          </p>
          <Button variant="outline" size="sm" disabled={q.isFetching} onClick={() => void q.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      <SessionTable
        items={items}
        loading={q.isLoading}
        error={q.isError}
        hasMore={q.hasNextPage}
        loadingMore={q.isFetchingNextPage}
        onEndReached={loadMore}
      />
    </div>
  );
}
