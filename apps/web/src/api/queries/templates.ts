import type { TemplateDto } from '@orc/api-contract';
import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export const templatesKey = (projectId?: string) => ['templates', projectId ?? null] as const;

export function useTemplates(projectId?: string) {
  return useQuery<TemplateDto[]>({
    queryKey: templatesKey(projectId),
    queryFn: () => getApiClient().templatesList(projectId),
    staleTime: 300_000,
  });
}
