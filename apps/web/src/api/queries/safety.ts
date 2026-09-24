import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function useSecretsReport() {
  return useQuery({
    queryKey: ['safety', 'secrets'],
    queryFn: () => getApiClient().safetySecrets(),
    staleTime: 60_000,
  });
}

export function usePlans(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: ['plans', query],
    queryFn: () => getApiClient().plansList(query, 10),
    enabled: query.length >= 2,
    staleTime: 30_000,
  });
}

export function usePlanContent(path: string | null) {
  return useQuery({
    queryKey: ['plan', path],
    queryFn: () => getApiClient().plansContent(path ?? ''),
    enabled: path !== null,
    staleTime: 30_000,
  });
}
