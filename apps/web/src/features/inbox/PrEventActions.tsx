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

type PrPayload = { pr?: PrRef; cwd?: string | null; presetId?: string | null; vars?: Record<string, string> };

export function PrEventActions({ item }: { item: InboxItem }) {
  const p = item.payload as PrPayload;
  const review = item.sessionId ? splitPk(item.sessionId) : null;
  const { presetId, cwd } = p;
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
