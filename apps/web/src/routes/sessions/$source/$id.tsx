import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SessionDetailPage } from '@/features/session-detail/SessionDetailPage.tsx';
import type { DetailNavigation } from '@/features/session-detail/tabs/SessionDetailTabs.tsx';
import { isSource } from '@/lib/source.ts';

const DetailSearch = z.object({
  tab: z.enum(['timeline', 'agents', 'usage', 'files', 'links', 'raw']).optional().catch(undefined),
  agent: z.string().optional().catch(undefined),
  file: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/sessions/$source/$id')({
  validateSearch: DetailSearch,
  component: SessionDetailRoute,
});

function SessionDetailRoute() {
  const { source, id } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  if (!isSource(source)) return <p className="p-4">Unknown source "{source}".</p>;
  const onNavigate = (n: DetailNavigation) =>
    void navigate({
      search: (prev) => ({
        ...prev,
        ...(n.tab !== undefined ? { tab: n.tab } : {}),
        ...(n.agent !== undefined ? { agent: n.agent ?? undefined } : {}),
        ...(n.file !== undefined ? { file: n.file ?? undefined } : {}),
      }),
    });
  return (
    <SessionDetailPage
      key={`${source}:${id}`}
      source={source}
      id={id}
      tab={search.tab ?? 'timeline'}
      agentId={search.agent ?? null}
      file={search.file ?? null}
      onNavigate={onNavigate}
    />
  );
}
