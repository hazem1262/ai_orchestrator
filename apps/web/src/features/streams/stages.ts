import type { StreamStage, WorkStream } from '@orc/core';
import type { BadgeVariant } from '@/components/ui/badge.tsx';

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

/** Badge tone for each stage: neutral while planned, primary while active, warning in review, success once shipped. */
export const STAGE_BADGE_VARIANT: Record<StreamStage, BadgeVariant> = {
  planned: 'outline',
  implementing: 'default',
  in_review: 'warning',
  pr_open: 'warning',
  merged: 'success',
  backmerged: 'success',
  released: 'success',
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

/**
 * Strips the XML-ish wrappers Claude Code puts in first prompts (`<command-message>…</command-message>`,
 * `<recommended_plugins>…`) so a raw prompt can stand in as a stream title (audit F24).
 */
export function cleanTitle(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/<([a-z_-]+)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?[a-z_-]+>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
