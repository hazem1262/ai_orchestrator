import type { AuditQuery } from '@orc/api-contract';
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export type AuditFilter = Partial<AuditQuery>;

export function useAudit(filter: AuditFilter) {
  return useQuery({
    queryKey: ['audit', filter],
    queryFn: () => getApiClient().auditList(filter),
    staleTime: 2_000,
  });
}
