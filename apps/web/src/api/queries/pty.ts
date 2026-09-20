import type { ResumeRequest } from '@orc/api-contract';
import type { Source } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function usePtyList() {
  return useQuery({ queryKey: ['pty'], queryFn: () => getApiClient().ptyList(), refetchInterval: 5000 });
}

export function useKillPty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ptyId: string) => getApiClient().ptyKill(ptyId),
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: ['pty'] });
      await qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function useResumeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { source: Source; id: string; body: ResumeRequest }) =>
      getApiClient().sessionsResume(v.source, v.id, v.body),
    onSettled: async (_data, _err, v) => {
      await qc.invalidateQueries({ queryKey: ['session', v.source, v.id], exact: true });
      await qc.invalidateQueries({ queryKey: ['sessions'] });
      await qc.invalidateQueries({ queryKey: ['pty'] });
    },
  });
}
