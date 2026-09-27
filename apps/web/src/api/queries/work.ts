import type { GoalPutBody, ReminderCreateBody } from '@orc/api-contract';
import type { Goal, Source } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

const STALE_MS = 10_000;

export const workKeys = {
  recap: (s: Source, id: string) => ['recap', s, id] as const,
  spend: ['recaps', 'spend'] as const,
  goal: (t: 'session' | 'stream', id: string) => ['goal', t, id] as const,
  goals: (states?: string) => ['goals', states ?? 'all'] as const,
  handoff: (s: Source, id: string) => ['handoff', s, id] as const,
  reminders: (f: { sessionPk?: string }) => ['reminders', f] as const,
};

const RECAP_ERRORS: Record<string, string> = {
  recaps_disabled: 'Recaps are off for this project — turn them on in Settings.',
  too_small: 'This session has too few prompts for an automatic recap.',
  over_budget: 'The monthly recap budget is used up.',
  engine_unavailable: 'The recap engine is not available (check the engine and API key in Settings).',
};

export function errorMessage(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return (typeof code === 'string' ? RECAP_ERRORS[code] : undefined) ?? 'Could not generate the recap.';
}

export function useSessionRecap(source: Source, id: string) {
  return useQuery({
    queryKey: workKeys.recap(source, id),
    queryFn: () => getApiClient().recapsGetSession(source, id),
    staleTime: STALE_MS,
  });
}

export function useRunRecap(source: Source, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: { onDemand?: boolean } | undefined) =>
      getApiClient().recapsRunSession(source, id, opts?.onDemand ?? true),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workKeys.recap(source, id) });
      void qc.invalidateQueries({ queryKey: ['session', source, id] });
      void qc.invalidateQueries({ queryKey: workKeys.spend });
    },
  });
}

export function useRecapSpend() {
  return useQuery({
    queryKey: workKeys.spend,
    queryFn: () => getApiClient().recapsSpend(),
    staleTime: STALE_MS,
  });
}

export function useGoal(targetType: 'session' | 'stream', targetId: string) {
  return useQuery({
    queryKey: workKeys.goal(targetType, targetId),
    queryFn: () => getApiClient().goalsGet(targetType, targetId),
    staleTime: STALE_MS,
  });
}

export function useSetGoal(targetType: 'session' | 'stream', targetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GoalPutBody) => getApiClient().goalsSet(targetType, targetId, body),
    onSuccess: (goal: Goal) => {
      qc.setQueryData(
        workKeys.goal(targetType, targetId),
        (old: { goal: Goal | null; prefill: string } | undefined) => ({
          goal,
          prefill: old?.prefill ?? goal.objective,
        }),
      );
      void qc.invalidateQueries({ queryKey: ['streams'] });
    },
  });
}

export function useLatestHandoff(source: Source, id: string) {
  return useQuery({
    queryKey: workKeys.handoff(source, id),
    queryFn: () => getApiClient().handoffsLatest(source, id),
    staleTime: STALE_MS,
  });
}

export function useGenerateHandoff(source: Source, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getApiClient().handoffsGenerate(source, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: workKeys.handoff(source, id) }),
  });
}

export function useResumeFresh() {
  return useMutation({ mutationFn: (handoffId: string) => getApiClient().handoffsResumeFresh(handoffId) });
}

export function useReminders(f: { sessionPk?: string }) {
  return useQuery({
    queryKey: workKeys.reminders(f),
    queryFn: () => getApiClient().remindersList({ state: ['pending'], ...f }),
    staleTime: STALE_MS,
  });
}

export function useCreateReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReminderCreateBody) => getApiClient().remindersCreate(body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reminders'] }),
  });
}

export function useCancelReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().remindersCancel(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reminders'] }),
  });
}
