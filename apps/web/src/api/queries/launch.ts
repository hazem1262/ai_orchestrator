import type { OpenInApp } from '@orc/api-contract';
import type { Source } from '@orc/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function useKill() {
  return useMutation<{ killed: 'pty' | 'pid' }, Error, { source: Source; id: string }>({
    mutationFn: ({ source, id }) => getApiClient().sessionsKill(source, id, true),
  });
}

export function useOpenIn() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { source: Source; id: string; app: OpenInApp }>({
    // `remember: true` stores the choice on the project server-side; the local store mirrors it.
    mutationFn: ({ source, id, app }) => getApiClient().sessionsOpenIn(source, id, app, true),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}
