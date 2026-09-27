import { createFileRoute } from '@tanstack/react-router';
import { PairPage } from '@/features/remote/PairPage.tsx';

export const Route = createFileRoute('/pair')({ component: PairRoute });

function PairRoute() {
  return <PairPage />;
}
