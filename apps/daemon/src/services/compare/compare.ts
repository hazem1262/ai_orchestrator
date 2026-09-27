import { randomUUID } from 'node:crypto';
import type {
  ArchiveLosersResult,
  CompareEstimate,
  CompareGroup,
  CompareVariant,
  CompareVariantView,
  CompareView,
  LaunchRequest,
} from '@orc/api-contract';
import { splitPk } from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import * as repo from '../../db/repos/compare.ts';
import { ServiceError } from '../errors.ts';
import { type DiffStat, diffStat } from '../git/git-info.ts';
import { assertOwnedCapacity } from '../launch/spawn.ts';
import { sessionPk } from '../sessions.ts';

export interface CompareService {
  launch(req: LaunchRequest): Promise<CompareGroup>;
  estimate(projectId: string | null, n: number): CompareEstimate;
  get(id: string): CompareGroup | null;
  view(id: string): Promise<CompareView>;
  pickWinner(id: string, index: number): { group: CompareGroup; reviewUrl: string };
  archiveLosers(id: string): Promise<ArchiveLosersResult>;
}

export interface CompareDeps {
  ctx: DaemonContext;
  now?: () => Date;
  resolveSessionByCwd?: (cwd: string) => string | null;
  diffStatFn?: (cwd: string, base: string) => Promise<DiffStat>;
}

export function variantLabel(
  v: { source: 'claude' | 'codex'; model?: string | null },
  index: number,
): string {
  return `v${index + 1} ${v.source}${v.model ? `:${v.model}` : ''}`;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const hi = s[mid] ?? 0;
  if (s.length % 2 === 1) return hi;
  const lo = s[mid - 1] ?? hi;
  return (lo + hi) / 2;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const slugPart = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function required<T>(svc: T | undefined, name: string): T {
  if (svc === undefined) throw new ServiceError('not_enabled', 409, `${name} is not running`);
  return svc;
}

export function createCompareService(
  deps: CompareDeps,
): CompareService & { list(limit?: number): CompareGroup[] } {
  const { ctx } = deps;
  const now = deps.now ?? (() => new Date());
  const resolveSessionByCwd =
    deps.resolveSessionByCwd ?? ((cwd: string) => repo.findSessionPkByCwd(ctx.db, cwd));
  const diffStatFn = deps.diffStatFn ?? diffStat;

  const emit = (group: CompareGroup) => ctx.bus.emit({ type: 'compare.updated', group });

  function estimate(projectId: string | null, n: number): CompareEstimate {
    const usage = required(ctx.usage, 'usage meter');
    const costs = ctx.sessions
      .list({ projectId: projectId ?? undefined, limit: 50 })
      .items.map((i) => i.costUsd)
      .filter((c): c is number => c !== null && c > 0);
    const med = median(costs);
    return {
      variants: n,
      multiplier: n,
      avgSessionCostUsd: med === null ? null : round2(med),
      estimatedUsd: med === null ? null : round2(med * n),
      sample: costs.length,
      burnRateUsdPerHour: usage.snapshot().burnRateUsdPerHour,
      budget: usage.checkBudget({ projectId: projectId ?? undefined }),
    };
  }

  async function launch(req: LaunchRequest): Promise<CompareGroup> {
    const wanted = req.compare ?? [];
    const max = ctx.config().compare.maxVariants;
    if (wanted.length < 2)
      throw new ServiceError('validation_failed', 400, 'compare mode needs at least 2 variants');
    if (wanted.length > max) {
      throw new ServiceError('validation_failed', 400, `compare mode allows at most ${max} variants`);
    }
    const wt = req.worktree;
    if (!wt) {
      throw new ServiceError(
        'validation_failed',
        400,
        'compare mode needs a worktree (repo, base, type, slug); each variant gets its own',
      );
    }
    const budget = required(ctx.usage, 'usage meter').checkBudget({
      projectId: req.projectId ?? undefined,
      ticket: req.ticket,
    });
    if (!budget.ok) {
      throw new ServiceError('over_budget', 409, `budget is at ${Math.round(budget.pct * 100)}%`, budget);
    }
    assertOwnedCapacity(ctx, req.projectId, wanted.length);
    const est = estimate(req.projectId, wanted.length);
    const launcher = required(ctx.launcher, 'launch service');
    const worktrees = required(ctx.worktrees, 'worktree service');

    // Sequential on purpose: each worktree runs its setup script and each launch counts against the owned cap.
    const variants: CompareVariant[] = [];
    for (const [index, v] of wanted.entries()) {
      const variant: CompareVariant = {
        index,
        source: v.source,
        model: v.model ?? null,
        label: variantLabel(v, index),
        sessionId: null,
        sessionPk: null,
        ptyId: null,
        worktreePath: null,
        branch: null,
        error: null,
      };
      try {
        const { view } = await worktrees.createWith(
          {
            repo: wt.repo,
            base: wt.base,
            type: wt.type,
            ticket: req.ticket ?? null,
            slug: `${wt.slug}-v${index + 1}-${slugPart(`${v.source}${v.model ? `-${v.model}` : ''}`)}`,
          },
          { runSetup: true, actor: 'user' },
        );
        variant.worktreePath = view.path;
        variant.branch = view.branch;
        const res = await launcher.launch({
          ...req,
          source: v.source,
          model: v.model,
          cwd: view.path,
          worktree: undefined,
          compare: undefined,
        });
        variant.ptyId = res.ptyId;
        variant.sessionId = res.sessionId;
        variant.sessionPk = res.sessionId ? sessionPk(v.source, res.sessionId) : null;
      } catch (e) {
        variant.error = e instanceof Error ? e.message : String(e);
      }
      variants.push(variant);
    }

    const group = repo.insertGroup(ctx.db, {
      id: randomUUID(),
      projectId: req.projectId,
      prompt: req.prompt || (req.templateId ? `template ${req.templateId}` : ''),
      ticket: req.ticket ?? null,
      repo: wt.repo,
      base: wt.base,
      createdAt: now().toISOString(),
      state: 'running',
      winnerIndex: null,
      estimateUsd: est.estimatedUsd,
      variants,
    });
    const allFailed = variants.every((v) => v.error);
    ctx.audit?.record({
      actor: 'user',
      actorDetail: null,
      action: 'compare.launch',
      target: `compare:${group.id}`,
      params: {
        variants: variants.map((v) => ({ label: v.label, error: v.error })),
        estimateUsd: est.estimatedUsd,
        ticket: group.ticket,
      },
      result: allFailed ? 'error' : 'ok',
      error: allFailed ? 'every variant failed to launch' : null,
    });
    emit(group);
    return group;
  }

  function mustGet(id: string): CompareGroup {
    const g = repo.getGroup(ctx.db, id);
    if (!g) throw new ServiceError('not_found', 404, `compare group ${id} not found`);
    return g;
  }

  /** Fills sessionPk/sessionId for variants launched without an id (Codex) and persists them. */
  function resolveSessions(g: CompareGroup): CompareGroup {
    let changed = false;
    const variants = g.variants.map((v): CompareVariant => {
      if (v.sessionPk || !v.worktreePath || v.error) return v;
      const pk = resolveSessionByCwd(v.worktreePath);
      if (!pk) return v;
      changed = true;
      return { ...v, sessionPk: pk, sessionId: splitPk(pk).id };
    });
    return changed ? repo.updateGroup(ctx.db, g.id, { variants }, now().toISOString()) : g;
  }

  async function view(id: string): Promise<CompareView> {
    const group = resolveSessions(mustGet(id));
    const variants = await Promise.all(
      group.variants.map(async (v): Promise<CompareVariantView> => {
        const s = v.sessionPk ? ctx.sessions.getByPk(v.sessionPk) : null;
        let diff: DiffStat | null = null;
        if (v.worktreePath) {
          try {
            diff = await diffStatFn(v.worktreePath, group.base);
          } catch {
            diff = null;
          }
        }
        return {
          ...v,
          status: v.error ? 'error' : (s?.live?.status ?? (s ? 'ended' : 'starting')),
          costUsd: s?.usage.costUsd ?? null,
          durationMs: s ? Math.max(0, Date.parse(s.lastActivityAt) - Date.parse(s.startedAt)) : null,
          tests: s?.lastTest ?? null,
          recap: s?.recap ?? s?.awaySummary ?? null,
          diff,
        };
      }),
    );
    return { group, variants };
  }

  function pickWinner(id: string, index: number): { group: CompareGroup; reviewUrl: string } {
    const g = resolveSessions(mustGet(id));
    if (g.state === 'archived') {
      throw new ServiceError('invalid_state', 409, 'this comparison is already archived');
    }
    const v = g.variants.find((x) => x.index === index);
    if (!v) throw new ServiceError('not_found', 404, `variant ${index} not found`);
    if (v.error || !v.sessionId) {
      throw new ServiceError('session_unknown', 409, `variant ${v.label} has no session yet`);
    }
    const group = repo.updateGroup(ctx.db, id, { state: 'decided', winnerIndex: index }, now().toISOString());
    ctx.audit?.record({
      actor: 'user',
      actorDetail: null,
      action: 'compare.pick',
      target: `compare:${id}`,
      params: { index, label: v.label, sessionPk: v.sessionPk },
      result: 'ok',
      error: null,
    });
    emit(group);
    return { group, reviewUrl: `/review/${v.source}/${encodeURIComponent(v.sessionId)}` };
  }

  /**
   * Touches only the worktrees this group created (each loser's `worktreePath` came from
   * `createWith` at launch). `archiveAs` refuses dirty and external worktrees and runs
   * `git worktree remove`, which keeps the branch, so unpushed commits are never deleted.
   * A second call skips worktrees already archived and retries only the ones that were kept.
   */
  async function archiveLosers(id: string): Promise<ArchiveLosersResult> {
    const g = mustGet(id);
    if (g.winnerIndex === null) {
      throw new ServiceError('invalid_state', 409, 'pick a winner before archiving the others');
    }
    const worktrees = required(ctx.worktrees, 'worktree service');
    const results: ArchiveLosersResult['results'] = [];
    for (const v of g.variants) {
      if (v.index === g.winnerIndex) continue;
      let killed = false;
      if (v.ptyId) {
        const info = ctx.pty.get(v.ptyId);
        if (info && info.exitedAt === null) {
          ctx.pty.kill(v.ptyId);
          killed = true;
          ctx.audit?.record({
            actor: 'user',
            actorDetail: null,
            action: 'session.kill',
            target: v.sessionPk ?? `pty:${v.ptyId}`,
            params: { compareGroupId: id, index: v.index },
            result: 'ok',
            error: null,
          });
        }
      }
      if (!v.worktreePath) {
        results.push({ index: v.index, worktreePath: null, killed, archived: false, reason: 'no worktree' });
        continue;
      }
      if (worktrees.get(v.worktreePath)?.state === 'archived') {
        results.push({ index: v.index, worktreePath: v.worktreePath, killed, archived: true, reason: null });
        continue;
      }
      try {
        await worktrees.archiveAs(v.worktreePath, 'user');
        results.push({ index: v.index, worktreePath: v.worktreePath, killed, archived: true, reason: null });
      } catch (e) {
        results.push({
          index: v.index,
          worktreePath: v.worktreePath,
          killed,
          archived: false,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    const allArchived = results.every((r) => r.archived || r.worktreePath === null);
    const group = allArchived
      ? repo.updateGroup(ctx.db, id, { state: 'archived' }, now().toISOString())
      : mustGet(id);
    ctx.audit?.record({
      actor: 'user',
      actorDetail: null,
      action: 'compare.archive',
      target: `compare:${id}`,
      params: { results },
      result: allArchived ? 'ok' : 'error',
      error: allArchived ? null : 'some worktrees were kept (uncommitted changes or external)',
    });
    emit(group);
    return { group, results };
  }

  return {
    launch,
    estimate,
    get: (id) => repo.getGroup(ctx.db, id),
    list: (limit) => repo.listGroups(ctx.db, limit),
    view,
    pickWinner,
    archiveLosers,
  };
}
