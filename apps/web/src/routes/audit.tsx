import { AuditActorSchema } from '@orc/api-contract';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { AuditPage } from '@/features/audit/AuditPage.tsx';

const AuditSearchSchema = z.object({
  sessionPk: z.string().optional().catch(undefined),
  action: z.string().optional().catch(undefined),
  actor: AuditActorSchema.optional().catch(undefined),
  from: z.string().optional().catch(undefined),
  to: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  projectId: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/audit')({
  validateSearch: AuditSearchSchema,
  component: AuditRoute,
});

function AuditRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <AuditPage search={search} onSearch={(next) => void navigate({ search: next, replace: true })} />;
}
