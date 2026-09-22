import type { Session } from '@orc/core';
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export const liveKey = ['live'] as const;

export function useLive() {
  return useQuery<Session[]>({
    queryKey: liveKey,
    queryFn: () => getApiClient().liveList(),
    staleTime: 30_000,
  });
}
