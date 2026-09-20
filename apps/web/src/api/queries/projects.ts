import type { ProjectPatch } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => getApiClient().projectsList(),
    staleTime: 60_000,
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; patch: ProjectPatch }) => getApiClient().projectsUpdate(v.id, v.patch),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}
