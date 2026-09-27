import type { SupervisorRuleInput, SupervisorSettingsPatch, SupervisorTarget } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '@/api/client.ts';

/** `supervisor.decided` live events invalidate `supervisor-decisions` and `supervisor-status` (`live-events.ts`). */
export const supervisorKeys = {
  status: ['supervisor-status'] as const,
  targets: ['supervisor-targets'] as const,
  rules: ['supervisor-rules'] as const,
  decisions: (sessionPk?: string) => ['supervisor-decisions', sessionPk ?? 'all'] as const,
};

export function useSupervisorStatus() {
  return useQuery({ queryKey: supervisorKeys.status, queryFn: () => getApiClient().supervisorStatus() });
}

export function useSupervisorSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SupervisorSettingsPatch) => getApiClient().supervisorSettings(patch),
    onSuccess: (s) => qc.setQueryData(supervisorKeys.status, s),
  });
}

export function useSupervisorTargets() {
  return useQuery({ queryKey: supervisorKeys.targets, queryFn: () => getApiClient().supervisorTargets() });
}

export function useSetSupervisorTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (t: SupervisorTarget) => getApiClient().supervisorSetTarget(t),
    onSuccess: () => qc.invalidateQueries({ queryKey: supervisorKeys.targets }),
  });
}

export function useSupervisorRules() {
  return useQuery({ queryKey: supervisorKeys.rules, queryFn: () => getApiClient().supervisorRules() });
}

export function useAddSupervisorRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (r: SupervisorRuleInput) => getApiClient().supervisorAddRule(r),
    onSuccess: () => qc.invalidateQueries({ queryKey: supervisorKeys.rules }),
  });
}

/** The client sends `confirm: true`; callers ask the user first. */
export function useDeleteSupervisorRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().supervisorDeleteRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: supervisorKeys.rules }),
  });
}

export function useSupervisorDecisions(sessionPk?: string) {
  return useQuery({
    queryKey: supervisorKeys.decisions(sessionPk),
    queryFn: () => getApiClient().supervisorDecisions(sessionPk ? { sessionPk, limit: 50 } : { limit: 50 }),
  });
}

/** Refreshes every decisions list (the settings log and each session's), not only `sessionPk`'s. */
export function useMarkDecisionWrong(_sessionPk?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().supervisorMarkWrong(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['supervisor-decisions'] });
      void qc.invalidateQueries({ queryKey: supervisorKeys.rules });
    },
  });
}
