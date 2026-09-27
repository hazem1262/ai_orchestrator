import type { AwayMode, RemoteConfigBody } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export const remoteKeys = {
  status: ['remote-status'] as const,
  devices: ['remote-devices'] as const,
  away: ['away'] as const,
};

export function useRemoteStatus() {
  return useQuery({
    queryKey: remoteKeys.status,
    queryFn: () => getApiClient().remoteStatus(),
    refetchInterval: 30_000,
  });
}

export function useRemoteDevices() {
  return useQuery({ queryKey: remoteKeys.devices, queryFn: () => getApiClient().remoteDevices() });
}

export function useAway() {
  return useQuery({
    queryKey: remoteKeys.away,
    queryFn: () => getApiClient().awayGet(),
    refetchInterval: 30_000,
  });
}

export function useSetAway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: AwayMode) => getApiClient().awaySet(mode),
    onSuccess: (state) => qc.setQueryData(remoteKeys.away, state),
  });
}

export function useSaveRemoteConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RemoteConfigBody) => getApiClient().remoteSetConfig(body),
    onSuccess: (s) => qc.setQueryData(remoteKeys.status, s),
  });
}

export function useCreatePairingCode() {
  return useMutation({ mutationFn: () => getApiClient().remoteCreatePairing() });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().remoteRevokeDevice(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: remoteKeys.devices }),
  });
}
