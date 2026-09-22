import type { InboxItem, InboxKind, InboxState } from '@orc/core';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../client.ts';

export interface InboxFilters {
  state?: InboxState[];
  kind?: InboxKind[];
  projectId?: string;
}

/** The prefix every filtered inbox list shares, for invalidation and cache sweeps. */
export const inboxRootKey = ['inbox'] as const;

export const inboxKey = (f: InboxFilters) => ['inbox', f] as const;

/** `null`, `undefined` and the "all projects" sentinel all mean "no project filter". */
export function scopeProject(projectId: string | null | undefined): string | undefined {
  return projectId && projectId !== 'all' ? projectId : undefined;
}

export function matchesInboxFilter(item: InboxItem, f: InboxFilters): boolean {
  if (f.state?.length && !f.state.includes(item.state)) return false;
  if (f.kind?.length && !f.kind.includes(item.kind)) return false;
  if (f.projectId && item.projectId !== f.projectId) return false;
  return true;
}

/**
 * Rewrites every cached `['inbox', filters]` list: the item is dropped from all of them and
 * re-added only where it still matches. That is how an item that just went `done` leaves the
 * open list without a refetch.
 */
export function upsertInboxItemInCache(qc: QueryClient, item: InboxItem): void {
  for (const [key, data] of qc.getQueriesData<InboxItem[]>({ queryKey: ['inbox'] })) {
    if (!data) continue;
    const filters = (key[1] ?? {}) as InboxFilters;
    const rest = data.filter((i) => i.id !== item.id);
    const next = matchesInboxFilter(item, filters) ? [item, ...rest] : rest;
    next.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    qc.setQueryData(key, next);
  }
}

export function useInbox(f: InboxFilters) {
  return useQuery<InboxItem[]>({ queryKey: inboxKey(f), queryFn: () => getApiClient().inboxList(f) });
}

export type InboxAction =
  | { id: string; action: 'done' }
  | { id: string; action: 'reopen' }
  | { id: string; action: 'snooze'; until: string };

export function useInboxAction() {
  const qc = useQueryClient();
  return useMutation<InboxItem, Error, InboxAction>({
    mutationFn: (a) => {
      const api = getApiClient();
      if (a.action === 'done') return api.inboxDone(a.id);
      if (a.action === 'reopen') return api.inboxReopen(a.id);
      return api.inboxSnooze(a.id, a.until);
    },
    onSuccess: (item) => upsertInboxItemInCache(qc, item),
  });
}

export function useOpenInboxCount(projectId?: string): number {
  const filters: InboxFilters = projectId ? { state: ['open'], projectId } : { state: ['open'] };
  return useInbox(filters).data?.length ?? 0;
}
