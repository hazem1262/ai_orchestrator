import type { CheckpointRecord, DiffResult, ReviewSummary, Source } from '@orc/core';
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function useDiff(cwd: string | null, from?: string, to?: string) {
  return useQuery<DiffResult>({
    queryKey: ['diff', cwd, from ?? null, to ?? null],
    enabled: cwd !== null,
    queryFn: () =>
      getApiClient().diffGet({ cwd: cwd ?? '', ...(from ? { from } : {}), ...(to ? { to } : {}) }),
  });
}

export function useCheckpoints(sessionPk: string) {
  return useQuery<CheckpointRecord[]>({
    queryKey: ['checkpoints', sessionPk],
    queryFn: () => getApiClient().checkpointsList(sessionPk),
  });
}

export function useCheckpointDiff(id: string | null) {
  return useQuery<DiffResult>({
    queryKey: ['checkpoint-diff', id],
    enabled: id !== null,
    queryFn: () => getApiClient().checkpointsDiff(id ?? ''),
  });
}

export function useReview(source: Source, id: string) {
  return useQuery<ReviewSummary>({
    queryKey: ['review', source, id],
    queryFn: () => getApiClient().reviewGet(source, id),
  });
}
