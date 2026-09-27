import type { Settings, SettingsUpdateBody } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';
import { usageKeys } from './usage.ts';

export const settingsKeys = {
  all: ['settings'] as const,
  hooks: ['hooks', 'install'] as const,
  statusline: ['hooks', 'statusline'] as const,
};

export function useSettings() {
  return useQuery({
    queryKey: settingsKeys.all,
    queryFn: () => getApiClient().settingsGet(),
    staleTime: 30_000,
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsUpdateBody) => getApiClient().settingsUpdate(body),
    onSuccess: (s: Settings) => {
      qc.setQueryData(settingsKeys.all, s);
      void qc.invalidateQueries({ queryKey: usageKeys.snapshot });
    },
  });
}

export function useHookStatus() {
  return useQuery({
    queryKey: settingsKeys.hooks,
    queryFn: () => getApiClient().hooksInstallStatus(),
    staleTime: 30_000,
  });
}

export function useInstallHooks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getApiClient().hooksInstall(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.hooks }),
  });
}

export function useStatuslineSnippet() {
  return useQuery({
    queryKey: settingsKeys.statusline,
    queryFn: () => getApiClient().hooksStatusline(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
