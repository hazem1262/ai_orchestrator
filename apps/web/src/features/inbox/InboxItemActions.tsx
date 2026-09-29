import type { InboxItem } from '@orc/core';
import { PlanApprovalActions } from './PlanApprovalActions.tsx';
import { PrEventActions } from './PrEventActions.tsx';

/** The kind-specific panel an expanded inbox row shows under its triage buttons. */
export function InboxItemActions({ item }: { item: InboxItem }) {
  switch (item.kind) {
    case 'plan_approval':
      return <PlanApprovalActions item={item} />;
    case 'pr_event':
      return <PrEventActions item={item} />;
    default:
      return null;
  }
}
