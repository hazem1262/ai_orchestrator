import type { Source } from '@orc/core';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

const STALE_MS = 5_000;

export const detailKeys = {
  agents: (s: Source, id: string) => ['session', s, id, 'agents'] as const,
  stats: (s: Source, id: string) => ['session', s, id, 'stats'] as const,
  deliverables: (s: Source, id: string) => ['session', s, id, 'deliverables'] as const,
  files: (s: Source, id: string) => ['session', s, id, 'files'] as const,
  usage: (s: Source, id: string) => ['session', s, id, 'usage'] as const,
  safety: (s: Source, id: string) => ['session', s, id, 'safety'] as const,
  links: (s: Source, id: string) => ['session', s, id, 'links'] as const,
  raw: (s: Source, id: string, agentId: string | null) =>
    ['session', s, id, 'raw', agentId ?? 'main'] as const,
};

export function useSessionAgents(source: Source, id: string) {
  return useQuery({
    queryKey: detailKeys.agents(source, id),
    queryFn: () => getApiClient().sessionsAgents(source, id),
    staleTime: STALE_MS,
  });
}

export function useSessionStats(source: Source, id: string) {
  return useQuery({
    queryKey: detailKeys.stats(source, id),
    queryFn: () => getApiClient().sessionsStats(source, id),
    staleTime: STALE_MS,
  });
}

export function useSessionDeliverables(source: Source, id: string) {
  return useQuery({
    queryKey: detailKeys.deliverables(source, id),
    queryFn: () => getApiClient().sessionsDeliverables(source, id),
    staleTime: STALE_MS,
  });
}

export function useSessionFiles(source: Source, id: string) {
  return useQuery({
    queryKey: detailKeys.files(source, id),
    queryFn: () => getApiClient().sessionsFiles(source, id),
    staleTime: STALE_MS,
  });
}

export function useSessionUsageSeries(source: Source, id: string) {
  return useQuery({
    queryKey: detailKeys.usage(source, id),
    queryFn: () => getApiClient().sessionsUsageSeries(source, id),
    staleTime: STALE_MS,
  });
}

export function useSessionSafety(source: Source, id: string) {
  return useQuery({
    queryKey: detailKeys.safety(source, id),
    queryFn: () => getApiClient().sessionsSafety(source, id),
    staleTime: STALE_MS,
  });
}

export function useSessionLinks(source: Source, id: string) {
  return useQuery({
    queryKey: detailKeys.links(source, id),
    queryFn: () => getApiClient().sessionsLinks(source, id),
    staleTime: 30_000,
  });
}

export function useSessionRaw(source: Source, id: string, agentId: string | null) {
  return useInfiniteQuery({
    queryKey: detailKeys.raw(source, id, agentId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getApiClient().sessionsRaw(source, id, { agentId, offset: pageParam, limit: 200 }),
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  });
}

export async function downloadSessionExport(
  source: Source,
  id: string,
  opts: { redact: boolean },
): Promise<void> {
  const blob = await getApiClient().sessionsExport(source, id, opts);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${source}-${id}${opts.redact ? '' : '-UNREDACTED'}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
