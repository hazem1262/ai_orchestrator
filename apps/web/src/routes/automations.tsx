import { createFileRoute } from '@tanstack/react-router';
import { AutomationsPage } from '@/features/automations/AutomationsPage.tsx';

export const Route = createFileRoute('/automations')({ component: AutomationsRoute });

function AutomationsRoute() {
  return <AutomationsPage />;
}
