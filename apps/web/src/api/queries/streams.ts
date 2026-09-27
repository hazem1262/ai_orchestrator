import type { StreamLinkKind, StreamStage } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

const STALE_MS = 15_000;

export interface StreamFilters {
  projectId?: string;
  stage?: StreamStage;
}

export const streamKeys = {
  list: (f: StreamFilters) => ['streams', f] as const,
  detail: (ticket: string) => ['stream', ticket] as const,
};

export function useStreams(f: StreamFilters) {
  return useQuery({
    queryKey: streamKeys.list(f),
    queryFn: () => getApiClient().streamsList(f),
    staleTime: STALE_MS,
  });
}

export function useStream(ticket: string) {
  return useQuery({
    queryKey: streamKeys.detail(ticket),
    queryFn: () => getApiClient().streamsGet(ticket),
    staleTime: STALE_MS,
  });
}

export function useRefreshStreams() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getApiClient().streamsRefresh(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['streams'] }),
  });
}

function useLinkMutation(ticket: string, verb: 'link' | 'unlink') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { kind: StreamLinkKind; ref: string }) =>
      verb === 'link' ? getApiClient().streamsLink(ticket, b) : getApiClient().streamsUnlink(ticket, b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: streamKeys.detail(ticket) });
      void qc.invalidateQueries({ queryKey: ['streams'] });
    },
  });
}

export const useLinkStream = (ticket: string) => useLinkMutation(ticket, 'link');
export const useUnlinkStream = (ticket: string) => useLinkMutation(ticket, 'unlink');
