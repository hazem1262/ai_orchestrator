import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ProjectConfig } from '@orc/api-contract';
import {
  applyManualLinks,
  collectTicketSignals,
  computeStreamStage,
  groupSignals,
  type Handoff,
  type PrRef,
  type StreamDetail,
  type StreamLink,
  type StreamLinkKind,
  type StreamPlanInput,
  type StreamPr,
  type StreamSessionInput,
  type StreamStage,
  type StreamTimelineItem,
  type StreamWorkflowInput,
  type StreamWorktreeInput,
  type WorkStream,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import {
  getStream,
  listLinks,
  listStreams,
  replaceAutoLinks,
  setManualLink,
  upsertStream,
} from '../../db/repos/streams.ts';
import type { PrSource } from '../pr-source.ts';
import { listAllSessions } from '../session-pages.ts';
import type { UsageMeter } from '../usage/meter.ts';
import { readWstackWorkflows, resolveWstackHome } from '../wstack.ts';

export interface StreamService {
  refresh(): Promise<WorkStream[]>;
  refreshIfStale(): Promise<void>;
  list(q: { projectId?: string; stage?: StreamStage }): WorkStream[];
  get(ticket: string): Promise<StreamDetail | null>;
  link(ticket: string, kind: StreamLinkKind, ref: string): StreamLink;
  unlink(ticket: string, kind: StreamLinkKind, ref: string): StreamLink;
  start(): void;
  stop(): void;
}

interface Sources {
  sessions: StreamSessionInput[];
  prs: StreamPr[];
  plans: StreamPlanInput[];
  workflows: StreamWorkflowInput[];
  worktrees: StreamWorktreeInput[];
}

const EMPTY: Sources = { sessions: [], prs: [], plans: [], workflows: [], worktrees: [] };
const MAX_PLAN_DEPTH = 4;

/** File names only: no plan content is read. Symlinks and `.key` files are skipped. */
function walkPlans(dir: string, depth: number, out: StreamPlanInput[]): void {
  if (depth > MAX_PLAN_DEPTH || !existsSync(dir)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    const p = join(dir, d.name);
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) walkPlans(p, depth + 1, out);
    else if (d.isFile() && d.name.endsWith('.md')) {
      try {
        out.push({ path: p, mtime: statSync(p).mtime.toISOString() });
      } catch {
        // vanished between readdir and stat: skip
      }
    }
  }
}

const firstLine = (s: string | null) => (s ? (s.split('\n').find((l) => l.trim().length > 0) ?? null) : null);
const maxIso = (xs: Array<string | null | undefined>) =>
  xs
    .filter((x): x is string => typeof x === 'string')
    .sort()
    .at(-1) ?? null;

export function createStreamService(
  ctx: DaemonContext,
  deps: {
    prs: PrSource;
    meter: Pick<UsageMeter, 'checkBudget'>;
    now?: () => Date;
    staleMs?: number;
    refreshMs?: number;
    sessionDays?: number;
  },
): StreamService {
  const now = deps.now ?? (() => new Date());
  const staleMs = deps.staleMs ?? 30_000;
  let lastRefresh = 0;
  let sources: Sources = EMPTY;
  let running: Promise<WorkStream[]> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const unsubs: Array<() => void> = [];

  const enabledProjects = (): ProjectConfig[] => ctx.config().projects.filter((p) => p.features.workStreams);

  async function gather(projects: ProjectConfig[]): Promise<Sources> {
    const ids = new Set(projects.map((p) => p.id));
    const from = new Date(now().getTime() - (deps.sessionDays ?? 90) * 86_400_000).toISOString();
    const sessions: StreamSessionInput[] = [];
    for (const p of projects) {
      for (const item of listAllSessions(ctx, { projectId: p.id, from })) {
        const full = ctx.sessions.getByPk(item.pk);
        sessions.push({
          pk: item.pk,
          projectId: item.projectId,
          name: item.name,
          firstPrompt: item.firstPrompt,
          lastPrompt: item.lastPrompt,
          tickets: item.tickets,
          prs: item.prs,
          skills: full?.skills ?? [],
          costUsd: item.costUsd,
          startedAt: item.startedAt,
          lastActivityAt: item.lastActivityAt,
          liveStatus: item.live?.status ?? null,
          recap: item.recap,
        });
      }
    }
    const plans: StreamPlanInput[] = [];
    for (const p of projects) for (const prefix of p.pathPrefixes) walkPlans(join(prefix, 'plans'), 0, plans);
    walkPlans(join(ctx.paths.claudeHome, 'plans'), MAX_PLAN_DEPTH, plans);
    const worktrees: StreamWorktreeInput[] = [];
    if (ctx.worktrees) {
      for (const w of await ctx.worktrees.discover()) {
        // The shipped P4 `Worktree` carries no projectId or updatedAt: resolve the project from the path.
        const pid = ctx.projects.resolve(w.path);
        if (pid !== null && ids.has(pid)) {
          worktrees.push({ path: w.path, branch: w.branch, ticket: w.ticket, updatedAt: null });
        }
      }
    }
    return {
      sessions,
      prs: deps.prs.list(),
      plans,
      workflows: readWstackWorkflows(resolveWstackHome()),
      worktrees,
    };
  }

  async function doRefresh(): Promise<WorkStream[]> {
    const projects = enabledProjects();
    const nowIso = now().toISOString();
    if (projects.length === 0) {
      sources = EMPTY;
      lastRefresh = now().getTime();
      return [];
    }
    sources = await gather(projects);
    const pattern = projects[0]?.ticketRegex ?? null;
    const signals = applyManualLinks(collectTicketSignals(sources, pattern), listLinks(ctx.db));
    const byPk = new Map(sources.sessions.map((s) => [s.pk, s]));
    const byUrl = new Map(sources.prs.map((p) => [p.pr.url, p]));
    const byPlan = new Map(sources.plans.map((p) => [p.path, p]));
    const byFlow = new Map(sources.workflows.map((w) => [w.file, w]));
    const out: WorkStream[] = [];

    for (const g of groupSignals(signals)) {
      const sessions = g.refs.session
        .map((pk) => byPk.get(pk))
        .filter((s): s is StreamSessionInput => s !== undefined);
      const prs = g.refs.pr.map((u) => byUrl.get(u)).filter((p): p is StreamPr => p !== undefined);
      const counts = new Map<string, number>();
      for (const s of sessions) if (s.projectId) counts.set(s.projectId, (counts.get(s.projectId) ?? 0) + 1);
      const projectId =
        [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? projects[0]?.id ?? 'wakecap';
      if (!projects.some((p) => p.id === projectId)) continue;
      const stream: WorkStream = {
        ticket: g.ticket,
        projectId,
        title:
          prs.find((p) => !p.isBackmerge)?.title ??
          sessions.find((s) => s.name)?.name ??
          (g.refs.plan[0] ? basename(g.refs.plan[0], '.md') : null),
        stage: computeStreamStage({ prs, sessions, hasWorktrees: g.refs.worktree.length > 0 }),
        sessionIds: g.refs.session,
        prs: prs.map((p): PrRef => p.pr),
        plans: g.refs.plan,
        worktrees: g.refs.worktree,
        costUsd: sessions.reduce((a, s) => a + (s.costUsd ?? 0), 0),
        lastActivityAt:
          maxIso([
            ...sessions.map((s) => s.lastActivityAt),
            ...prs.map((p) => p.updatedAt),
            ...g.refs.plan.map((p) => byPlan.get(p)?.mtime),
            ...g.refs.workflow.map((f) => byFlow.get(f)?.mtime),
          ]) ?? nowIso,
      };
      upsertStream(ctx.db, stream, nowIso);
      replaceAutoLinks(
        ctx.db,
        g.ticket,
        signals
          .filter((s) => s.ticket === g.ticket && s.source !== 'manual')
          .map((s) => ({ kind: s.kind, ref: s.ref })),
        nowIso,
      );
      out.push(stream);
    }
    lastRefresh = now().getTime();
    return out;
  }

  function refresh(): Promise<WorkStream[]> {
    if (!running) {
      running = doRefresh().finally(() => {
        running = null;
      });
    }
    return running;
  }

  async function refreshIfStale(): Promise<void> {
    if (now().getTime() - lastRefresh > staleMs) await refresh();
  }

  /** The newest handoff across the stream's sessions. */
  function latestHandoff(stream: WorkStream): Handoff | null {
    let newest: Handoff | null = null;
    for (const pk of stream.sessionIds) {
      const h = ctx.handoffs?.latest(pk) ?? null;
      if (h && (newest === null || h.createdAt > newest.createdAt)) newest = h;
    }
    return newest;
  }

  function timeline(stream: WorkStream, links: StreamLink[], handoff: Handoff | null): StreamTimelineItem[] {
    const items: StreamTimelineItem[] = [];
    const byPk = new Map(sources.sessions.map((s) => [s.pk, s]));
    const byUrl = new Map(sources.prs.map((p) => [p.pr.url, p]));
    const byPlan = new Map(sources.plans.map((p) => [p.path, p]));
    const byTree = new Map(sources.worktrees.map((w) => [w.path, w]));
    for (const pk of stream.sessionIds) {
      const s = byPk.get(pk);
      if (!s) continue;
      items.push({
        ts: s.startedAt,
        kind: 'session',
        title: s.name ?? s.firstPrompt ?? pk,
        ref: pk,
        detail: firstLine(s.recap),
      });
      if (s.recap)
        items.push({ ts: s.lastActivityAt, kind: 'recap', title: 'Recap', ref: pk, detail: s.recap });
    }
    for (const ref of stream.prs) {
      const p = byUrl.get(ref.url);
      if (!p) continue;
      items.push({
        ts: p.mergedAt ?? p.updatedAt,
        kind: 'pr',
        title: `#${p.pr.number} ${p.title}`,
        ref: p.pr.url,
        detail: `${p.state}${p.isBackmerge ? ' · backmerge' : ''} · checks ${p.checks} · review ${p.review}`,
      });
    }
    for (const path of stream.plans) {
      const p = byPlan.get(path);
      if (p) items.push({ ts: p.mtime, kind: 'plan', title: basename(path), ref: path, detail: null });
    }
    for (const path of stream.worktrees) {
      const w = byTree.get(path);
      if (w) {
        items.push({
          ts: w.updatedAt ?? stream.lastActivityAt,
          kind: 'worktree',
          title: w.branch,
          ref: path,
          detail: null,
        });
      }
    }
    const flows = new Set(links.filter((l) => l.kind === 'workflow' && !l.excluded).map((l) => l.ref));
    for (const w of sources.workflows) {
      if (flows.has(w.file)) {
        items.push({
          ts: w.mtime,
          kind: 'workflow',
          title: w.env.WORKFLOW_ID ?? basename(w.file),
          ref: w.file,
          detail: w.env.BRANCH ?? null,
        });
      }
    }
    if (handoff) {
      items.push({
        ts: handoff.createdAt,
        kind: 'handoff',
        title: `Handoff: ${handoff.status}`,
        ref: handoff.id,
        detail: handoff.summary,
      });
    }
    const goal = ctx.goals?.get('stream', stream.ticket) ?? null;
    if (goal) {
      items.push({
        ts: goal.updatedAt,
        kind: 'goal',
        title: `Goal: ${goal.state}`,
        ref: goal.id,
        detail: goal.objective,
      });
    }
    items.sort((a, b) => b.ts.localeCompare(a.ts));
    return items;
  }

  const onError = (err: unknown) => ctx.log.warn({ err }, 'stream refresh failed');

  return {
    refresh,
    refreshIfStale,
    list: (q) => listStreams(ctx.db, q),
    async get(ticket) {
      await refreshIfStale();
      const stream = getStream(ctx.db, ticket.toUpperCase());
      if (!stream) return null;
      const links = listLinks(ctx.db, stream.ticket);
      const byUrl = new Map(sources.prs.map((p) => [p.pr.url, p]));
      const handoff = latestHandoff(stream);
      return {
        stream,
        prsDetailed: stream.prs.map((r) => byUrl.get(r.url)).filter((p): p is StreamPr => p !== undefined),
        links,
        timeline: timeline(stream, links, handoff),
        goal: ctx.goals?.get('stream', stream.ticket) ?? null,
        handoff,
        budget: deps.meter.checkBudget({ ticket: stream.ticket, projectId: stream.projectId }),
      };
    },
    link(ticket, kind, ref) {
      lastRefresh = 0;
      return setManualLink(ctx.db, ticket.toUpperCase(), kind, ref, false, now().toISOString());
    },
    unlink(ticket, kind, ref) {
      lastRefresh = 0;
      return setManualLink(ctx.db, ticket.toUpperCase(), kind, ref, true, now().toISOString());
    },
    start() {
      if (timer) return;
      refresh().catch(onError);
      timer = setInterval(() => {
        refresh().catch(onError);
      }, deps.refreshMs ?? 120_000);
      timer.unref?.();
      unsubs.push(
        ctx.bus.on('pr.changed', () => {
          lastRefresh = 0;
        }),
      );
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const u of unsubs.splice(0)) u();
    },
  };
}
