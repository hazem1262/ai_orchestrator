import type { PrRef } from '@orc/core';
import { usePrStatus } from '@/api/queries/github.ts';

const CHECK_MARK = { success: ' ✓', failure: ' ✗', pending: ' …', none: '' } as const;
const COLOR = {
  open: 'border-success',
  merged: 'border-primary',
  closed: 'border-muted-foreground',
} as const;

export function PrChip({ pr }: { pr: PrRef }) {
  const s = usePrStatus(pr).data;
  const label = s
    ? `PR #${pr.number}: ${s.state}, checks ${s.checks}, review ${s.review.replace('_', ' ')}`
    : `PR #${pr.number}`;
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={s?.title ?? pr.repo}
      className={`rounded border px-1.5 font-mono text-xs hover:bg-muted ${s ? COLOR[s.state] : ''}`}
    >
      {`#${pr.number}${s ? CHECK_MARK[s.checks] : ''}`}
    </a>
  );
}
