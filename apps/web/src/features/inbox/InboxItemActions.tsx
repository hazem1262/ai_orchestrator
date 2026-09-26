import type { InboxItem } from '@orc/core';
import { PlanApprovalActions } from './PlanApprovalActions.tsx';
import { PrEventActions } from './PrEventActions.tsx';

/** The kind-specific actions an inbox row renders below its shared triage buttons. */
export function InboxItemActions({ item }: { item: InboxItem }) {
  switch (item.kind) {
    case 'plan_approval':
      return (
        <div className="basis-full">
          <PlanApprovalActions item={item} />
        </div>
      );
    case 'pr_event':
      return (
        <div className="basis-full">
          <PrEventActions item={item} />
        </div>
      );
    default:
      return null;
  }
}
