import { createFileRoute } from '@tanstack/react-router';
import { type HistorySearch, parseHistorySearch } from '@/features/history/filters.ts';

export const Route = createFileRoute('/history')({
  validateSearch: (search: Record<string, unknown>): HistorySearch => parseHistorySearch(search),
  component: () => <h1 className="p-4 text-lg font-semibold">History</h1>,
});
