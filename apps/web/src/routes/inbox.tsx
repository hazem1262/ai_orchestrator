import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '@/features/inbox/InboxPage.tsx';

export const Route = createFileRoute('/inbox')({ component: InboxRoute });

function InboxRoute() {
  return <InboxPage />;
}
