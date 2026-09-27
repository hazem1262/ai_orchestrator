import type { StreamStage, WorkStream } from '@orc/core';

export const STAGE_ORDER: readonly StreamStage[] = [
  'planned',
  'implementing',
  'in_review',
  'pr_open',
  'merged',
  'backmerged',
  'released',
];

export const STAGE_LABELS: Record<StreamStage, string> = {
  planned: 'Planned',
  implementing: 'Implementing',
  in_review: 'In review',
  pr_open: 'PR open',
  merged: 'Merged',
  backmerged: 'Backmerged',
  released: 'Released',
};

export function stageIndex(s: StreamStage): number {
  return STAGE_ORDER.indexOf(s);
}

export function groupByStage(
  streams: WorkStream[],
): Array<{ stage: StreamStage; label: string; streams: WorkStream[] }> {
  return STAGE_ORDER.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    streams: streams.filter((s) => s.stage === stage),
  }));
}

export function sessionHref(pk: string): string {
  const [source, ...rest] = pk.split(':');
  return `/sessions/${source || 'claude'}/${encodeURIComponent(rest.join(':'))}`;
}

export function streamHref(ticket: string): string {
  return `/streams/${encodeURIComponent(ticket)}`;
}

export function formatActivity(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}
