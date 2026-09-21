import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function useSavedViews() {
  return useQuery({ queryKey: ['views'], queryFn: () => getApiClient().viewsList() });
}

export function useSaveView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; query: Record<string, string> }) => getApiClient().viewsSave(v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['views'] }),
  });
}

export function useDeleteView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApiClient().viewsDelete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['views'] }),
  });
}
