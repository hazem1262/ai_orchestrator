import { createFileRoute } from '@tanstack/react-router';
import { LiveBoard } from '@/features/live-board/LiveBoard.tsx';

export const Route = createFileRoute('/live')({ component: LiveRoute });

function LiveRoute() {
  return <LiveBoard />;
}
