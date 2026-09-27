import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '@/api/client.ts';

export const compareKeys = {
  group: (id: string) => ['compare', id] as const,
  estimate: (projectId: string | null, n: number) => ['compare-estimate', projectId ?? 'all', n] as const,
};

/** Polls every 5 s as a fallback; `compare.updated` live events invalidate it sooner. */
export function useCompare(groupId: string) {
  return useQuery({
    queryKey: compareKeys.group(groupId),
    queryFn: () => getApiClient().compareGet(groupId),
    refetchInterval: 5000,
  });
}

export function useCompareEstimate(projectId: string | null, n: number) {
  return useQuery({
    queryKey: compareKeys.estimate(projectId, n),
    queryFn: () => getApiClient().compareEstimate(projectId, n),
    enabled: n >= 2,
  });
}

export function usePickWinner(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (index: number) => getApiClient().comparePickWinner(groupId, index),
    onSuccess: () => qc.invalidateQueries({ queryKey: compareKeys.group(groupId) }),
  });
}
