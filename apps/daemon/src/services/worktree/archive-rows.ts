import type { PrRef } from '@orc/core';
import type { DaemonContext } from '../../context.ts';

/**
 * Merged worktrees the app didn't create share one inbox row per repo, so a repo with many
 * hand-made worktrees raises one item rather than one per worktree.
 */
export const EXTERNAL_EVENT = 'archive_external';

export interface ExternalEntry {
  path: string;
  pr: PrRef;
}

const key = (repo: string) =>
  ({ kind: 'pr_event', scope: { domain: 'repo', id: repo }, facet: EXTERNAL_EVENT }) as const;

const reasonFor = (label: string, n: number) =>
  n === 1
    ? `1 merged worktree in ${label} was not created by the app — archive it yourself`
    : `${n} merged worktrees in ${label} were not created by the app — archive them yourself`;

export function externalEntries(payload: Record<string, unknown>): ExternalEntry[] {
  const list = payload.worktrees;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is ExternalEntry =>
      typeof e === 'object' && e !== null && typeof (e as ExternalEntry).path === 'string',
  );
}

/** Open or snoozed grouped rows. */
export function externalRows(ctx: DaemonContext) {
  return (ctx.inbox?.list({ state: ['open', 'snoozed'], kind: ['pr_event'] }) ?? []).filter(
    (i) => i.payload.event === EXTERNAL_EVENT && typeof i.payload.repo === 'string',
  );
}

/** Writes the full list for a repo's row, replacing what it held; an empty list resolves it. */
export function setExternal(
  ctx: DaemonContext,
  repo: string,
  label: string,
  projectId: string | null,
  entries: ExternalEntry[],
): void {
  if (entries.length === 0) {
    ctx.inbox?.resolve(key(repo));
    return;
  }
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  ctx.inbox?.upsert({
    ...key(repo),
    sessionId: null,
    projectId,
    ticket: null,
    reason: reasonFor(label, sorted.length),
    payload: { event: EXTERNAL_EVENT, repo, label, worktrees: sorted, presetId: null, vars: {} },
  });
}

/** Adds or replaces one worktree in its repo's grouped row. */
export function addExternal(
  ctx: DaemonContext,
  w: { path: string; repo: string; projectId: string | null },
  pr: PrRef,
): void {
  const current = externalRows(ctx).find((i) => i.payload.repo === w.repo);
  const kept = current ? externalEntries(current.payload).filter((e) => e.path !== w.path) : [];
  setExternal(ctx, w.repo, pr.repo, w.projectId ?? current?.projectId ?? null, [
    ...kept,
    { path: w.path, pr: { repo: pr.repo, number: pr.number, url: pr.url } },
  ]);
}

/** Removes worktrees matching `drop` from every grouped row, resolving rows left empty. */
export function dropExternal(ctx: DaemonContext, drop: (e: ExternalEntry) => boolean): void {
  for (const item of externalRows(ctx)) {
    const entries = externalEntries(item.payload);
    const kept = entries.filter((e) => !drop(e));
    if (kept.length === entries.length) continue;
    const repo = item.payload.repo as string;
    const label = typeof item.payload.label === 'string' ? item.payload.label : repo;
    setExternal(ctx, repo, label, item.projectId, kept);
  }
}
