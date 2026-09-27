import type { AnalyticsGroupBy } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

const STALE_MS = 30_000;

export interface AnalyticsParams {
  from?: string;
  to?: string;
  projectId?: string;
}

export const analyticsKeys = {
  cost: (p: AnalyticsParams & { groupBy: AnalyticsGroupBy }) => ['analytics', 'cost', p] as const,
  top: (p: AnalyticsParams & { limit?: number }) => ['analytics', 'top', p] as const,
  tools: (p: AnalyticsParams & { bucket: string }) => ['analytics', 'tools', p] as const,
  timing: (p: AnalyticsParams & { bucket: string }) => ['analytics', 'timing', p] as const,
  outcomes: (p: AnalyticsParams) => ['analytics', 'outcomes', p] as const,
  wstack: (p: AnalyticsParams) => ['analytics', 'wstack', p] as const,
  digest: ['digest'] as const,
};

export function rangeFor(days: number, now: Date = new Date()): { from: string; to: string } {
  return { from: new Date(now.getTime() - days * 86_400_000).toISOString(), to: now.toISOString() };
}

export function useAnalyticsCost(p: AnalyticsParams & { groupBy: AnalyticsGroupBy }) {
  return useQuery({
    queryKey: analyticsKeys.cost(p),
    queryFn: () => getApiClient().analyticsCost(p),
    staleTime: STALE_MS,
  });
}

export function useAnalyticsTop(p: AnalyticsParams & { limit?: number }) {
  return useQuery({
    queryKey: analyticsKeys.top(p),
    queryFn: () => getApiClient().analyticsTop(p),
    staleTime: STALE_MS,
  });
}

export function useAnalyticsTools(p: AnalyticsParams & { bucket: 'day' | 'week' }) {
  return useQuery({
    queryKey: analyticsKeys.tools(p),
    queryFn: () => getApiClient().analyticsTools(p),
    staleTime: STALE_MS,
  });
}

export function useAnalyticsTiming(p: AnalyticsParams & { bucket: 'day' | 'week' }) {
  return useQuery({
    queryKey: analyticsKeys.timing(p),
    queryFn: () => getApiClient().analyticsTiming(p),
    staleTime: STALE_MS,
  });
}

export function useAnalyticsOutcomes(p: AnalyticsParams) {
  return useQuery({
    queryKey: analyticsKeys.outcomes(p),
    queryFn: () => getApiClient().analyticsOutcomes(p),
    staleTime: STALE_MS,
  });
}

export function useAnalyticsWstack(p: AnalyticsParams) {
  return useQuery({
    queryKey: analyticsKeys.wstack(p),
    queryFn: () => getApiClient().analyticsWstack(p),
    staleTime: STALE_MS,
  });
}

export function useDigest() {
  return useQuery({
    queryKey: analyticsKeys.digest,
    queryFn: () => getApiClient().analyticsDigestLatest(),
    staleTime: STALE_MS,
  });
}

export function useGenerateDigest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (weekStart?: string) => getApiClient().analyticsDigestGenerate(weekStart),
    onSuccess: (d) => qc.setQueryData(analyticsKeys.digest, d),
  });
}
