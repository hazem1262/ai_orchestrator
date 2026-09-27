import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export const linearKeys = {
  issue: (identifier: string | null) => ['linear-issue', identifier] as const,
};

export function useLinearIssue(identifier: string | null) {
  return useQuery({
    queryKey: linearKeys.issue(identifier),
    queryFn: () => getApiClient().linearIssue(identifier ?? ''),
    enabled: identifier !== null && identifier !== '',
    staleTime: 10 * 60_000,
    retry: false,
  });
}
