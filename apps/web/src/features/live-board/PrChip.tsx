import type { PrRef } from '@orc/core';
import { GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react';
import { usePrStatus } from '@/api/queries/github.ts';
import { cn } from '@/components/ui/cn.ts';
import { SOFT, type Tone } from './status.tsx';

const CHECK_MARK = { success: ' ✓', failure: ' ✗', pending: ' …', none: '' } as const;
const CHECK_TONE = { success: 'success', failure: 'danger', pending: 'warning', none: 'neutral' } as const;

export function PrChip({ pr }: { pr: PrRef }) {
  const s = usePrStatus(pr).data;
  const label = s
    ? `PR #${pr.number}: ${s.state}, checks ${s.checks}, review ${s.review.replace('_', ' ')}`
    : `PR #${pr.number}`;
  const tone: Tone = !s ? 'neutral' : s.state === 'merged' ? 'info' : CHECK_TONE[s.checks];
  const Icon =
    s?.state === 'merged' ? GitMerge : s?.state === 'closed' ? GitPullRequestClosed : GitPullRequest;
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={s?.title ?? pr.repo}
      data-state={s?.state}
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-sm px-1.5 font-mono text-xs font-medium hover:underline',
        SOFT[tone],
      )}
    >
      <Icon className="size-3" aria-hidden />
      {`#${pr.number}${s ? CHECK_MARK[s.checks] : ''}`}
    </a>
  );
}
