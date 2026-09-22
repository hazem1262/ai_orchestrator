import type { ArchiveRestoreResponse, ArchiveStatus, NotificationPrefs } from '@orc/api-contract';
import type { Source } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export const archiveStatusKey = ['archive', 'status'] as const;
export const notificationPrefsKey = ['config', 'notifications'] as const;

export function useArchiveStatus() {
  return useQuery<ArchiveStatus>({
    queryKey: archiveStatusKey,
    queryFn: () => getApiClient().archiveStatus(),
    staleTime: 30_000,
  });
}

export function useArchiveRestore() {
  const qc = useQueryClient();
  return useMutation<ArchiveRestoreResponse, Error, { source: Source; id: string }>({
    // `confirm` is always true here: the browser asked before the call was made.
    mutationFn: ({ source, id }) => getApiClient().archiveRestore(source, id, true),
    // A restored transcript changes the session's availability and the archive totals.
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['sessions'] });
      await qc.invalidateQueries({ queryKey: archiveStatusKey });
    },
  });
}

export function useNotificationPrefs() {
  return useQuery<NotificationPrefs>({
    queryKey: notificationPrefsKey,
    queryFn: () => getApiClient().notificationsGet(),
  });
}

export function useSaveNotificationPrefs() {
  const qc = useQueryClient();
  return useMutation<NotificationPrefs, Error, NotificationPrefs>({
    mutationFn: (prefs) => getApiClient().notificationsPut(prefs),
    onSuccess: (prefs) => qc.setQueryData(notificationPrefsKey, prefs),
  });
}
