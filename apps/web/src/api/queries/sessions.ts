import type { Source } from '@orc/core';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export const EVENTS_PAGE_SIZE = 200;

export function useSession(source: Source, id: string) {
  return useQuery({
    queryKey: ['session', source, id],
    queryFn: () => getApiClient().sessionsGet(source, id),
  });
}

export function useSessionEvents(source: Source, id: string, agentId: string | null) {
  return useInfiniteQuery({
    queryKey: ['session', source, id, 'events', agentId],
    queryFn: ({ pageParam }) =>
      getApiClient().sessionsEvents(source, id, {
        agentId: agentId ?? undefined,
        afterSeq: pageParam,
        limit: EVENTS_PAGE_SIZE,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextSeq,
  });
}
