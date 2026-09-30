import type { InboxItem, PrRef } from '@orc/core';
import { Link } from '@tanstack/react-router';
import { ExternalLink, GitCompare, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { launchPreset } from '@/features/review/PresetButtons.tsx';
import { splitPk } from './PlanApprovalActions.tsx';

const PRESET_LABEL: Record<string, string> = {
  'preset-fix-ci': 'Fix CI',
  'preset-address-comments': 'Address comments',
};

type PrPayload = {
  pr?: PrRef;
  cwd?: string | null;
  presetId?: string | null;
  vars?: Record<string, string>;
  worktrees?: Array<{ path: string; pr: PrRef }>;
};

export function PrEventActions({ item }: { item: InboxItem }) {
  const p = item.payload as PrPayload;
  const review = item.sessionId ? splitPk(item.sessionId) : null;
  const { presetId, cwd } = p;
  if (Array.isArray(p.worktrees)) return <WorktreeList worktrees={p.worktrees} />;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {p.pr && (
        <Button size="sm" variant="outline" asChild>
          <a href={p.pr.url} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden="true" />
            {`Open PR #${p.pr.number}`}
          </a>
        </Button>
      )}
      {review && (
        <Button size="sm" variant="outline" asChild>
          <Link to="/review/$source/$id" params={review}>
            <GitCompare aria-hidden="true" />
            Review
          </Link>
        </Button>
      )}
      {presetId && cwd && (
        <Button
          size="sm"
          onClick={() => void launchPreset(presetId, { cwd, projectId: item.projectId, vars: p.vars ?? {} })}
        >
          <Wrench aria-hidden="true" />
          {PRESET_LABEL[presetId] ?? presetId}
        </Button>
      )}
    </div>
  );
}

/** The worktrees a grouped archive row lists, each with a link to its merged PR. */
function WorktreeList({ worktrees }: { worktrees: Array<{ path: string; pr: PrRef }> }) {
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {worktrees.map((w) => (
        <li key={w.path} className="flex flex-wrap items-center gap-2">
          <code className="break-all text-xs">{w.path}</code>
          <a
            className="inline-flex items-center gap-1 underline"
            href={w.pr.url}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink aria-hidden="true" className="size-3" />
            {`PR #${w.pr.number}`}
          </a>
        </li>
      ))}
    </ul>
  );
}
