import type { BudgetUpsertInput } from '@orc/api-contract';
import type { Source } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

const STALE_MS = 10_000;

export const usageKeys = {
  snapshot: ['usage'] as const,
  budgets: ['usage', 'budgets'] as const,
  concurrency: ['usage', 'concurrency'] as const,
  context: (source: Source, id: string) => ['usage', 'context', source, id] as const,
};

export function useUsage() {
  return useQuery({
    queryKey: usageKeys.snapshot,
    queryFn: () => getApiClient().usageGet(),
    staleTime: STALE_MS,
    refetchInterval: 60_000,
  });
}

export function useBudgets() {
  return useQuery({
    queryKey: usageKeys.budgets,
    queryFn: () => getApiClient().usageBudgets(),
    staleTime: STALE_MS,
  });
}

export function useUpsertBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: BudgetUpsertInput) => getApiClient().usageBudgetUpsert(b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: usageKeys.budgets });
      void qc.invalidateQueries({ queryKey: usageKeys.snapshot, exact: true });
    },
  });
}

export function useDeleteBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().usageBudgetDelete(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: usageKeys.budgets }),
  });
}

export function useConcurrency() {
  return useQuery({
    queryKey: usageKeys.concurrency,
    queryFn: () => getApiClient().usageConcurrency(),
    staleTime: 30_000,
  });
}

export function useContextFill(source: Source, id: string) {
  return useQuery({
    queryKey: usageKeys.context(source, id),
    queryFn: () => getApiClient().usageContext(source, id),
    staleTime: STALE_MS,
  });
}
