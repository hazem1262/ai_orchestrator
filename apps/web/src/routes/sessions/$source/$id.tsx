import { createFileRoute } from '@tanstack/react-router';
import { SessionDetailPage } from '@/features/session-detail/SessionDetailPage.tsx';
import { isSource } from '@/lib/source.ts';

export const Route = createFileRoute('/sessions/$source/$id')({ component: SessionDetailRoute });

function SessionDetailRoute() {
  const { source, id } = Route.useParams();
  if (!isSource(source)) return <p className="p-4">Unknown source "{source}".</p>;
  return <SessionDetailPage key={`${source}:${id}`} source={source} id={id} />;
}
