import type { ConnectorId } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export const connectorsKeys = {
  all: ['connectors'] as const,
};

export function useConnectors() {
  return useQuery({ queryKey: connectorsKeys.all, queryFn: () => getApiClient().connectorsList() });
}

function useInvalidateConnectors() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: connectorsKeys.all });
}

export function useSetConnectorToken() {
  const invalidate = useInvalidateConnectors();
  return useMutation({
    mutationFn: (v: { id: ConnectorId; token: string }) => getApiClient().connectorsSetToken(v.id, v.token),
    onSuccess: invalidate,
  });
}

export function useSetConnectorApp() {
  const invalidate = useInvalidateConnectors();
  return useMutation({
    mutationFn: (v: { id: ConnectorId; clientId: string; clientSecret: string }) =>
      getApiClient().connectorsSetApp(v.id, v.clientId, v.clientSecret),
    onSuccess: invalidate,
  });
}

export function useConnectorAuthorize() {
  return useMutation({ mutationFn: (id: ConnectorId) => getApiClient().connectorsAuthorize(id) });
}

export function useDisconnectConnector() {
  const invalidate = useInvalidateConnectors();
  return useMutation({
    mutationFn: (id: ConnectorId) => getApiClient().connectorsDisconnect(id, true),
    onSuccess: invalidate,
  });
}
