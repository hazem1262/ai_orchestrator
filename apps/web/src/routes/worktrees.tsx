import { createFileRoute } from '@tanstack/react-router';
import { WorktreesPage } from '@/features/worktrees/WorktreesPage.tsx';

export const Route = createFileRoute('/worktrees')({ component: WorktreesRoute });

function WorktreesRoute() {
  return <WorktreesPage />;
}
