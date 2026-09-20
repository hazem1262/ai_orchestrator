import type { SessionListFilters } from '@orc/api-contract';
import type { Source } from '@orc/core';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

export function useSessions(filters: SessionListFilters) {
  return useInfiniteQuery({
    queryKey: ['sessions', filters],
    queryFn: ({ pageParam }) =>
      getApiClient().sessionsList(pageParam ? { ...filters, cursor: pageParam } : filters),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function usePinSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { source: Source; id: string; pinned: boolean }) =>
      getApiClient().sessionsPin(v.source, v.id, v.pinned),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

export function useSetLabels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { source: Source; id: string; labels: string[] }) =>
      getApiClient().sessionsLabel(v.source, v.id, v.labels),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['sessions'] });
      await qc.invalidateQueries({ queryKey: ['labels'] });
    },
  });
}

export function useLabels() {
  return useQuery({ queryKey: ['labels'], queryFn: () => getApiClient().labelsList() });
}
