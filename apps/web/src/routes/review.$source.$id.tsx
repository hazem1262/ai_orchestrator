import { createFileRoute } from '@tanstack/react-router';
import { ReviewAside } from '@/features/review/ReviewAside.tsx';
import { ReviewPage } from '@/features/review/ReviewPage.tsx';
import { isSource } from '@/lib/source.ts';

export const Route = createFileRoute('/review/$source/$id')({ component: ReviewRoute });

function ReviewRoute() {
  const { source, id } = Route.useParams();
  if (!isSource(source)) return <p className="p-4">Unknown source "{source}".</p>;
  return (
    <ReviewPage
      key={`${source}:${id}`}
      source={source}
      id={id}
      aside={({ select, selected }) => (
        <ReviewAside source={source} id={id} select={select} selected={selected} />
      )}
    />
  );
}
