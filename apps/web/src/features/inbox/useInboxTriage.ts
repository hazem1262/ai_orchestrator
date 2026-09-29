import type { InboxItem } from '@orc/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { getApiClient } from '@/api/client.ts';
import { type InboxAction, upsertInboxItemInCache, useInboxAction } from '@/api/queries/inbox.ts';
import { withStepUp } from '@/api/step-up.ts';
import type { InboxGroup } from './kinds.ts';

export interface InboxTriage {
  done(group: InboxGroup): void;
  snooze(group: InboxGroup, until: string, label: string): void;
  reopen(group: InboxGroup): void;
  approve(group: InboxGroup): void;
  busy: boolean;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Done, snooze, reopen and approve for a whole row (every item in a group), each confirmed with a
 * toast. Done and snooze offer Undo: the item is reopened, then re-snoozed if it was snoozed before.
 */
export function useInboxTriage(): InboxTriage {
  const qc = useQueryClient();
  const action = useInboxAction();
  const approveOne = useMutation({
    mutationFn: (id: string) => withStepUp(() => getApiClient().inboxApprove(id)),
    onSuccess: (next) => upsertInboxItemInCache(qc, next),
  });
  const { mutateAsync } = action;

  const run = useCallback(
    (items: InboxItem[], make: (item: InboxItem) => InboxAction) =>
      Promise.all(items.map((item) => mutateAsync(make(item)))),
    [mutateAsync],
  );

  const restore = useCallback(
    async (before: InboxItem[]) => {
      await run(before, (i) => ({ id: i.id, action: 'reopen' }));
      const resnooze = before.filter(
        (i) => i.state === 'snoozed' && i.snoozeUntil && Date.parse(i.snoozeUntil) > Date.now(),
      );
      await run(resnooze, (i) => ({ id: i.id, action: 'snooze', until: i.snoozeUntil as string }));
    },
    [run],
  );

  const withUndo = useCallback(
    (title: string, group: InboxGroup, work: Promise<unknown>) => {
      work.then(
        () =>
          toast.success(title, {
            description: group.lead.reason,
            action: {
              label: 'Undo',
              onClick: () => void restore(group.items).catch((e) => toast.error(message(e))),
            },
          }),
        (e) => toast.error(message(e)),
      );
    },
    [restore],
  );

  const busy = action.isPending || approveOne.isPending;

  return useMemo<InboxTriage>(
    () => ({
      busy,
      done: (group) =>
        withUndo(
          'Marked done',
          group,
          run(group.items, (i) => ({ id: i.id, action: 'done' })),
        ),
      snooze: (group, until, label) =>
        withUndo(
          `Snoozed · ${label}`,
          group,
          run(group.items, (i) => ({ id: i.id, action: 'snooze', until })),
        ),
      reopen: (group) =>
        run(group.items, (i) => ({ id: i.id, action: 'reopen' })).then(
          () => toast('Reopened', { description: group.lead.reason }),
          (e) => toast.error(message(e)),
        ),
      approve: (group) =>
        approveOne.mutateAsync(group.lead.id).then(
          () => toast.success('Approved', { description: group.lead.reason }),
          (e) => toast.error(message(e)),
        ),
    }),
    [busy, withUndo, run, approveOne.mutateAsync],
  );
}
