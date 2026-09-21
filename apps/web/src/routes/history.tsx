import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { type HistorySearch, parseHistorySearch } from '@/features/history/filters.ts';
import { HistoryPage } from '@/features/history/HistoryPage.tsx';

export const Route = createFileRoute('/history')({
  validateSearch: (search: Record<string, unknown>): HistorySearch => parseHistorySearch(search),
  component: HistoryRoute,
});

function HistoryRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/history' });
  return (
    <HistoryPage search={search} onSearchChange={(next) => void navigate({ search: next, replace: true })} />
  );
}
