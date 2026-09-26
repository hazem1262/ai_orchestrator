import type { Source } from '@orc/core';
import { useReview } from '@/api/queries/review.ts';
import { CheckpointTimeline } from './CheckpointTimeline.tsx';
import { PresetButtons } from './PresetButtons.tsx';
import type { DiffSourceSel } from './ReviewPage.tsx';
import { ShipPanel } from './ShipPanel.tsx';
import { SummaryCard } from './SummaryCard.tsx';

export function ReviewAside({
  source,
  id,
  select,
  selected,
}: {
  source: Source;
  id: string;
  select(s: DiffSourceSel): void;
  selected: DiffSourceSel;
}) {
  const review = useReview(source, id);
  if (!review.data) return null;
  return (
    <>
      <SummaryCard summary={review.data} />
      <PresetButtons summary={review.data} />
      <CheckpointTimeline sessionPk={review.data.sessionPk} selected={selected} onSelect={select} />
      {review.data.worktree && !review.data.worktree.isMain && <ShipPanel summary={review.data} />}
    </>
  );
}
