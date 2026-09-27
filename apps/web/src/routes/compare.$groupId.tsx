import { createFileRoute, useRouter } from '@tanstack/react-router';
import { ComparePage } from '@/features/compare/ComparePage.tsx';

export const Route = createFileRoute('/compare/$groupId')({ component: CompareRoute });

function CompareRoute() {
  const { groupId } = Route.useParams();
  const router = useRouter();
  return <ComparePage groupId={groupId} navigate={(url) => router.history.push(url)} />;
}
