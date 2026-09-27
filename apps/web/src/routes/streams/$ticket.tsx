import { createFileRoute } from '@tanstack/react-router';
import { StreamDetailPage } from '@/features/streams/StreamDetailPage.tsx';

export const Route = createFileRoute('/streams/$ticket')({ component: StreamRoute });

function StreamRoute() {
  const { ticket } = Route.useParams();
  return <StreamDetailPage key={ticket} ticket={ticket} />;
}
