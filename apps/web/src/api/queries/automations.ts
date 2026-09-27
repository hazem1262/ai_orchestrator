import type { AutomationInput, AutomationSettingsPatch } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '@/api/client.ts';

export const automationKeys = {
  list: ['automations'] as const,
  settings: ['automation-settings'] as const,
  runs: (id: string) => ['automation-runs', id] as const,
  log: (runId: string) => ['automation-run-log', runId] as const,
  suggestions: ['automation-suggestions'] as const,
};

export function useAutomations() {
  return useQuery({ queryKey: automationKeys.list, queryFn: () => getApiClient().automationsList() });
}

export function useAutomationSettingsGet() {
  return useQuery({
    queryKey: automationKeys.settings,
    queryFn: () => getApiClient().automationsSettingsGet(),
  });
}

export function useAutomationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: AutomationSettingsPatch) => getApiClient().automationsSettings(patch),
    onSuccess: (data) => qc.setQueryData(automationKeys.settings, data),
  });
}

export function useSaveAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: AutomationInput) => getApiClient().automationsSave(a),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.list }),
  });
}

export function useSetAutomationEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      getApiClient().automationsSetEnabled(v.id, v.enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.list }),
  });
}

export function useRunAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().automationsRun(id),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: automationKeys.list });
      void qc.invalidateQueries({ queryKey: automationKeys.runs(run.automationId) });
    },
  });
}

export function useAutomationRuns(id: string | null) {
  return useQuery({
    queryKey: automationKeys.runs(id ?? ''),
    queryFn: () => getApiClient().automationsRuns(id ?? ''),
    enabled: id !== null,
  });
}

/** Polls while the run can still write output; a finished run's log is read once. */
export function useRunLog(runId: string | null, live: boolean) {
  return useQuery({
    queryKey: automationKeys.log(runId ?? ''),
    queryFn: () => getApiClient().automationsRunLog(runId ?? ''),
    enabled: runId !== null,
    refetchInterval: live ? 5000 : false,
  });
}

/** Reject and rerun need no confirmation; approve goes through the daemon's 409 confirmation flow. */
export function useRunAction(automationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { runId: string; action: 'reject' | 'rerun' }) =>
      v.action === 'reject'
        ? getApiClient().automationsReject(v.runId)
        : getApiClient().automationsRerun(v.runId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: automationKeys.runs(automationId) });
      void qc.invalidateQueries({ queryKey: automationKeys.list });
    },
  });
}

export function useSuggestions() {
  return useQuery({
    queryKey: automationKeys.suggestions,
    queryFn: () => getApiClient().suggestionsList('new'),
  });
}

export function useRefreshSuggestions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getApiClient().suggestionsRefresh(),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.suggestions }),
  });
}

/** Dismiss needs no confirmation; accept goes through the daemon's 409 confirmation flow. */
export function useDismissSuggestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().suggestionsDismiss(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: automationKeys.suggestions }),
  });
}
