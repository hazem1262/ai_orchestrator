import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  approxTokens,
  buildRecapDigest,
  DEFAULT_DAILY_PROMPT,
  DEFAULT_RECAP_PROMPT,
  firstLine,
  type Recap,
  type RecapEngineId,
  type RecapKind,
  redact,
  renderPromptTemplate,
  type Session,
  truncateText,
} from '@orc/core';
import type { DaemonContext } from '../../context.ts';
import { findRecap, latestRecap, saveRecap, setSessionRecap, spendBetween } from '../../db/repos/recaps.ts';
import { ServiceError } from '../errors.ts';
import { ensureCronJob, removeJobsOfType, type Scheduler } from '../scheduler/scheduler.ts';
import { listAllSessions, loadEvents } from '../session-pages.ts';
import {
  createAnthropicApiEngine,
  createClaudeCliEngine,
  type RecapEngine,
  RecapEngineError,
} from './engines.ts';

export interface RecapService {
  recap(
    sessionPk: string,
    opts?: { onDemand?: boolean },
  ): Promise<{ text: string; costUsd: number; model: string; cached: boolean }>;
  daily(projectId: string, date: string): Promise<string>;
  latest(sessionPk: string): Recap | null;
  latestDaily(projectId: string, date: string): Recap | null;
  findCached(kind: RecapKind, targetKey: string, offset: number): Recap | null;
  runLlm(
    kind: RecapKind,
    targetKey: string,
    offset: number,
    prompt: string,
    opts: { onDemand: boolean; approxTokens: number },
  ): Promise<Recap>;
  monthSpend(now?: Date): { spentUsd: number; budgetUsd: number };
  syncSchedule(): void;
  start(): void;
  stop(): void;
}

/** The cache key's offset: the transcript's byte size (read-only stat), or the last activity time when there is no file. */
export function transcriptOffset(s: Pick<Session, 'transcriptPath' | 'lastActivityAt'>): number {
  if (s.transcriptPath && existsSync(s.transcriptPath)) return statSync(s.transcriptPath).size;
  return Date.parse(s.lastActivityAt);
}

export function defaultRecapEngines(ctx: DaemonContext): Record<RecapEngineId, RecapEngine> {
  return {
    'claude-cli': createClaudeCliEngine({
      command: ctx.config().resumeProfile.claudeCommand,
      cwd: join(ctx.paths.orcHome, 'recap-work'),
    }),
    // Phase 6 replaces getApiKey with SecretStore.get('anthropic.apiKey').
    'anthropic-api': createAnthropicApiEngine({
      getApiKey: async () => process.env.ANTHROPIC_API_KEY ?? null,
      prices: () => ctx.config().limits.pricing,
    }),
  };
}

const monthRange = (d: Date) => {
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { from: from.toISOString(), to: to.toISOString(), key: from.toISOString().slice(0, 7) };
};

const errCode = (err: unknown): string | undefined => (err instanceof ServiceError ? err.code : undefined);

export function createRecapService(
  ctx: DaemonContext,
  deps: {
    engines: Record<RecapEngineId, RecapEngine>;
    scheduler: Scheduler;
    now?: () => Date;
    idleMs?: number;
  },
): RecapService {
  const now = deps.now ?? (() => new Date());
  const idleTimers = new Map<string, NodeJS.Timeout>();
  const unsubs: Array<() => void> = [];

  function monthSpend(at: Date = now()) {
    const m = monthRange(at);
    return { spentUsd: spendBetween(ctx.db, m.from, m.to), budgetUsd: ctx.config().recaps.monthlyBudgetUsd };
  }

  async function runLlm(
    kind: RecapKind,
    targetKey: string,
    offset: number,
    prompt: string,
    opts: { onDemand: boolean; approxTokens: number },
  ): Promise<Recap> {
    const cfg = ctx.config().recaps;
    const spend = monthSpend();
    if (spend.spentUsd >= spend.budgetUsd) {
      const key = monthRange(now()).key;
      ctx.inbox?.upsert({
        kind: 'budget',
        scope: { domain: 'recap-budget', id: key },
        reason: `LLM recap budget used up for ${key}: $${spend.spentUsd.toFixed(2)} of $${spend.budgetUsd.toFixed(2)}`,
        payload: { recaps: true, ...spend },
      });
      throw new ServiceError('over_budget', 409, 'monthly recap budget reached', spend);
    }
    const model = opts.onDemand ? cfg.onDemandModel : cfg.autoModel;
    const engine = deps.engines[cfg.engine];
    let result: Awaited<ReturnType<RecapEngine['run']>>;
    try {
      result = await engine.run(prompt, {
        model,
        maxBudgetUsd: Math.max(0.01, spend.budgetUsd - spend.spentUsd),
      });
    } catch (err) {
      const code = err instanceof RecapEngineError ? err.code : 'engine_failed';
      ctx.log.warn({ kind, engine: cfg.engine, model, code }, 'recap engine failed');
      if (code === 'engine_unavailable')
        throw new ServiceError('engine_unavailable', 422, (err as Error).message);
      throw new ServiceError('engine_failed', 500, 'recap engine failed', { code });
    }
    ctx.log.info(
      { kind, engine: result.engine, model: result.model, costUsd: result.costUsd },
      'recap generated',
    );
    return saveRecap(ctx.db, {
      id: randomUUID(),
      kind,
      targetKey,
      transcriptOffset: offset,
      model: result.model,
      engine: result.engine,
      text: result.text,
      costUsd: result.costUsd,
      inputTokensApprox: opts.approxTokens,
      createdAt: now().toISOString(),
    });
  }

  function assertAllowed(s: Session, onDemand: boolean): void {
    const cfg = ctx.config().recaps;
    const project = s.projectId ? ctx.projects.get(s.projectId) : null;
    if (project && project.features.recaps === false) {
      throw new ServiceError('recaps_disabled', 409, 'recaps are disabled for this project');
    }
    if (s.projectId && cfg.excludeProjectIds.includes(s.projectId)) {
      throw new ServiceError('recaps_disabled', 409, 'this project is excluded from recaps');
    }
    if (!onDemand && !cfg.enabled)
      throw new ServiceError('recaps_disabled', 409, 'automatic recaps are disabled');
    if (!onDemand && s.promptCount < cfg.minPrompts) {
      throw new ServiceError('too_small', 409, 'session has too few prompts');
    }
  }

  async function recap(pk: string, opts: { onDemand?: boolean } = {}) {
    const onDemand = opts.onDemand ?? false;
    const s = ctx.sessions.getByPk(pk);
    if (!s) throw new ServiceError('not_found', 404, 'session not found');
    assertAllowed(s, onDemand);
    const offset = transcriptOffset(s);
    const hit = findRecap(ctx.db, 'session', pk, offset);
    if (hit) return { text: hit.text, costUsd: hit.costUsd, model: hit.model, cached: true };
    const cfg = ctx.config().recaps;
    const digest = buildRecapDigest({
      session: s,
      events: loadEvents(ctx, s, null),
      tests: s.lastTest ? [s.lastTest] : [],
      plans: [],
      maxInputTokens: cfg.maxInputTokens,
    });
    const prompt = renderPromptTemplate(cfg.promptTemplate ?? DEFAULT_RECAP_PROMPT, {
      language: cfg.language,
      digest: digest.text,
    });
    const rec = await runLlm('session', pk, offset, prompt, { onDemand, approxTokens: approxTokens(prompt) });
    setSessionRecap(ctx.db, pk, rec.text);
    ctx.bus.emit({
      type: 'session.updated',
      session: { ...(ctx.sessions.getByPk(pk) ?? s), recap: rec.text },
    });
    return { text: rec.text, costUsd: rec.costUsd, model: rec.model, cached: false };
  }

  async function daily(projectId: string, date: string): Promise<string> {
    const cfg = ctx.config().recaps;
    const from = `${date}T00:00:00.000Z`;
    const to = `${date}T23:59:59.999Z`;
    const items = listAllSessions(ctx, { projectId, from, to }).filter(
      (s) => s.lastActivityAt >= from && s.startedAt <= to,
    );
    if (items.length === 0) return `No sessions on ${date}.`;
    const offset = Math.max(...items.map((s) => Date.parse(s.lastActivityAt)));
    const key = `${projectId}:${date}`;
    const hit = findRecap(ctx.db, 'daily', key, offset);
    if (hit) return hit.text;
    const lines = items.map((s) => {
      const cost = s.costUsd === null ? '' : ` ($${s.costUsd.toFixed(2)})`;
      const tickets = s.tickets.length ? ` tickets: ${s.tickets.join(', ')}` : '';
      const prs = s.prs.length ? ` PRs: ${s.prs.map((p) => p.url).join(', ')}` : '';
      const live = s.live ? ` [${s.live.status}]` : '';
      const stored = s.recap ?? latestRecap(ctx.db, 'session', s.pk)?.text ?? null;
      const summary = firstLine(stored) ?? truncateText(s.lastPrompt ?? s.firstPrompt ?? 'no recap', 200);
      return redact(`- ${s.name ?? s.firstPrompt ?? s.pk}${cost}${tickets}${prs}${live} — ${summary}`);
    });
    const digest = truncateText(lines.join('\n'), cfg.maxInputTokens * 4);
    const prompt = renderPromptTemplate(DEFAULT_DAILY_PROMPT, {
      language: cfg.language,
      project: projectId,
      date,
      digest,
    });
    const rec = await runLlm('daily', key, offset, prompt, {
      onDemand: false,
      approxTokens: approxTokens(prompt),
    });
    return rec.text;
  }

  function syncSchedule(): void {
    const cfg = ctx.config();
    if (cfg.recaps.enabled && cfg.recaps.trigger === 'daily') {
      ensureCronJob(deps.scheduler, 'digest', 'daily_recap', cfg.digest.dailyRecapCron);
    } else {
      removeJobsOfType(deps.scheduler, 'digest', 'daily_recap');
    }
  }

  async function runDailyJob(): Promise<void> {
    const date = now().toISOString().slice(0, 10);
    for (const projectId of ctx.config().recaps.dailyProjectIds) {
      for (const s of listAllSessions(ctx, { projectId, from: `${date}T00:00:00.000Z` })) {
        await recap(s.pk).catch((err: unknown) =>
          ctx.log.debug({ pk: s.pk, code: errCode(err) }, 'daily session recap skipped'),
        );
      }
      await daily(projectId, date).catch((err: unknown) =>
        ctx.log.warn({ projectId, code: errCode(err) }, 'daily recap failed'),
      );
    }
  }

  return {
    recap,
    daily,
    latest: (pk) => latestRecap(ctx.db, 'session', pk),
    latestDaily: (projectId, date) => latestRecap(ctx.db, 'daily', `${projectId}:${date}`),
    findCached: (kind, key, offset) => findRecap(ctx.db, kind, key, offset),
    runLlm,
    monthSpend,
    syncSchedule,
    start() {
      deps.scheduler.onFire('digest', async (job) => {
        if (job.payload.type === 'daily_recap') await runDailyJob();
      });
      syncSchedule();
      unsubs.push(
        ctx.bus.on('config.changed', syncSchedule),
        ctx.bus.on('session.statusChanged', (e) => {
          const t = idleTimers.get(e.pk);
          if (t) clearTimeout(t);
          idleTimers.delete(e.pk);
          const cfg = ctx.config().recaps;
          if (!cfg.enabled || cfg.trigger !== 'on_idle' || (e.to !== 'idle' && e.to !== 'ended')) return;
          idleTimers.set(
            e.pk,
            setTimeout(
              () => {
                idleTimers.delete(e.pk);
                const s = ctx.sessions.getByPk(e.pk);
                if (s?.live && s.live.status !== 'idle' && s.live.status !== 'ended') return;
                recap(e.pk).catch((err: unknown) =>
                  ctx.log.debug({ pk: e.pk, code: errCode(err) }, 'idle recap skipped'),
                );
              },
              deps.idleMs ?? cfg.idleMinutes * 60_000,
            ),
          );
        }),
      );
    },
    stop() {
      for (const u of unsubs.splice(0)) u();
      for (const t of idleTimers.values()) clearTimeout(t);
      idleTimers.clear();
    },
  };
}
