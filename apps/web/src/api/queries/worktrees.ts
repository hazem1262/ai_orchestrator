import type { WorktreeView } from '@orc/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export type WorktreeFilter = { projectId?: string; state?: 'active' | 'archived'; repo?: string };

export const worktreeKeys = {
  all: ['worktrees'] as const,
  list: (f: WorktreeFilter) => ['worktrees', f] as const,
};

export function useWorktrees(f: WorktreeFilter) {
  return useQuery<WorktreeView[]>({
    queryKey: worktreeKeys.list(f),
    queryFn: () => getApiClient().worktreesList(f),
  });
}

export function useDiscoverWorktrees() {
  const qc = useQueryClient();
  return useMutation<WorktreeView[], Error, void>({
    mutationFn: () => getApiClient().worktreesDiscover(),
    onSuccess: () => qc.invalidateQueries({ queryKey: worktreeKeys.all }),
  });
}
