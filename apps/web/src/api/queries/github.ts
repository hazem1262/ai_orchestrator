import type { PrRef, PrStatus } from '@orc/core';
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function usePrStatus(pr: PrRef | null) {
  return useQuery<PrStatus>({
    queryKey: ['pr', pr?.repo ?? null, pr?.number ?? null],
    enabled: pr !== null,
    staleTime: 60_000,
    queryFn: () => getApiClient().githubPr(pr?.repo ?? '', pr?.number ?? 0),
  });
}

export function useGithubStatus() {
  return useQuery({
    queryKey: ['github', 'status'],
    queryFn: () => getApiClient().githubStatus(),
    staleTime: 300_000,
  });
}
