import type { InboxItem, PrRef } from '@orc/core';
import { Link } from '@tanstack/react-router';
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
        <a href={p.pr.url} target="_blank" rel="noreferrer" className="text-primary underline">
          {`Open PR #${p.pr.number}`}
        </a>
      )}
      {review && (
        <Link to="/review/$source/$id" params={review} className="text-primary underline">
          Review
        </Link>
      )}
      {presetId && cwd && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void launchPreset(presetId, { cwd, projectId: item.projectId, vars: p.vars ?? {} })}
        >
          {PRESET_LABEL[presetId] ?? presetId}
        </Button>
      )}
    </div>
  );
}
