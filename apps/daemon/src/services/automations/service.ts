import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Automation,
  type AutomationRunDetail,
  Automation as AutomationSchema,
  type AutomationWithStats,
  type TriggerSource,
} from '@orc/api-contract';
import { type AuditEntry, redact, splitPk } from '@orc/core';
import { Cron } from 'croner';
import type { DaemonContext } from '../../context.ts';
import * as repo from '../../db/repos/automations.ts';
import { ServiceError } from '../errors.ts';
import { defaultBranch, diffStat } from '../git/git-info.ts';
import { assertOwnedCapacity, spawnClaudeSession } from '../launch/spawn.ts';
import {
  APPROVAL_PROMPT,
  automationClaudeArgs,
  buildAutomationPrompt,
  checkAutomationGuards,
  type GuardResult,
} from './guardrails.ts';
import { formatStreamLine, type HeadlessRunner, type HeadlessRunResult, runHeadless } from './headless.ts';
import { waitForPtyTurn } from './pty-wait.ts';
import type { AutomationService } from './types.ts';

export interface TriggerFire {
  key: string;
  source: TriggerSource;
  vars: Record<string, string>;
  rerunOf?: string | null;
}

export interface AutomationDeps {
  ctx: DaemonContext;
  runner?: HeadlessRunner;
  now?: () => Date;
}

export interface AutomationServiceImpl extends AutomationService {
  get(id: string): Automation | null;
  listWithStats(): AutomationWithStats[];
  remove(id: string): void;
  setEnabled(id: string, enabled: boolean): Automation;
  start(id: string, fire: TriggerFire): Promise<AutomationRunDetail | null>;
  approve(runId: string): Promise<AutomationRunDetail>;
  reject(runId: string): AutomationRunDetail;
  rerun(runId: string): Promise<AutomationRunDetail | null>;
  runs(id: string): AutomationRunDetail[];
  run(runId: string): AutomationRunDetail | null;
  waitFor(runId: string): Promise<AutomationRunDetail>;
  logLines(runId: string): string[];
  onChange(fn: (id: string, a: Automation | null) => void): () => void;
  stop(): void;
}

const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
export function findPrUrl(text: string): string | null {
  return PR_URL_RE.exec(text)?.[0] ?? null;
}

export function monthStartIso(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export function validateCron(expr: string): void {
  try {
    new Cron(expr, { paused: true }).stop();
  } catch (e) {
    throw new ServiceError('validation_failed', 400, `invalid cron expression: ${(e as Error).message}`);
  }
}

export function nextRunAt(a: Automation, from: Date = new Date()): string | null {
  if (!a.enabled || a.trigger.type !== 'cron') return null;
  try {
    const job = new Cron(a.trigger.cron, { paused: true });
    const next = job.nextRun(from);
    job.stop();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'automation';

const TERMINAL = new Set<AutomationRunDetail['status']>([
  'success',
  'failed',
  'denied',
  'over_budget',
  'awaiting_approval',
]);

function required<T>(svc: T | undefined, name: string): T {
  if (svc === undefined) throw new ServiceError('not_enabled', 409, `${name} service is not running`);
  return svc;
}

interface Pending {
  runId: string;
  prompt: string;
  remainingUsd: number;
}

type RunOutcome = Pick<HeadlessRunResult, 'resultText' | 'isError' | 'timedOut' | 'costUsd'>;

export function createAutomationService(deps: AutomationDeps): AutomationServiceImpl {
  const { ctx } = deps;
  const runner = deps.runner ?? runHeadless;
  const now = deps.now ?? (() => new Date());
  const nowIso = () => now().toISOString();
  const queue: Pending[] = [];
  const active = new Set<string>();
  const waiters = new Map<string, Array<(r: AutomationRunDetail) => void>>();
  const listeners = new Set<(id: string, a: Automation | null) => void>();
  let stopped = false;

  repo.failStaleRuns(ctx.db, nowIso());

  const logPath = (runId: string) => join(ctx.paths.orcHome, 'logs', 'automations', `${runId}.jsonl`);

  function emit(run: AutomationRunDetail): void {
    ctx.bus.emit({ type: 'automation.runUpdated', run });
    if (!TERMINAL.has(run.status)) return;
    const ws = waiters.get(run.id);
    if (!ws) return;
    waiters.delete(run.id);
    for (const w of ws) w(run);
  }

  function update(id: string, patch: repo.RunPatch): AutomationRunDetail {
    const r = repo.updateRun(ctx.db, id, patch);
    emit(r);
    return r;
  }

  function mustGet(id: string): Automation {
    const a = repo.getAutomation(ctx.db, id);
    if (!a) throw new ServiceError('not_found', 404, `automation ${id} not found`);
    return a;
  }

  function sessionRef(pk: string | null): { source: string | null; id: string | null } {
    if (!pk) return { source: null, id: null };
    const { source, id } = splitPk(pk);
    return { source, id };
  }

  function notify(a: Automation, run: AutomationRunDetail): void {
    const ref = sessionRef(run.sessionPk);
    const firstLine = run.summary?.split('\n')[0]?.slice(0, 120);
    required(ctx.inbox, 'inbox').upsert({
      kind: 'automation_result',
      scope: { domain: 'automation-run', id: run.id },
      sessionId: ref.id,
      projectId: a.action.projectId,
      ticket: run.vars.ticket ?? null,
      reason: `${a.name}: ${run.status.replace('_', ' ')}${firstLine ? ` — ${firstLine}` : ''}`,
      payload: {
        source: ref.source,
        id: ref.id,
        automationId: a.id,
        runId: run.id,
        status: run.status,
        prUrl: run.prUrl,
        diffStat: run.diffStat,
        worktreePath: run.worktreePath,
        summary: run.summary,
        costUsd: run.costUsd,
      },
    });
  }

  function audit(
    a: Automation,
    run: AutomationRunDetail,
    result: AuditEntry['result'],
    error: string | null,
    extra: Record<string, unknown> = {},
  ): void {
    ctx.audit.record({
      actor: 'automation',
      actorDetail: a.name,
      action: 'automation.run',
      target: run.sessionPk ?? `automation-run:${run.id}`,
      params: {
        automationId: a.id,
        runId: run.id,
        trigger: run.triggerSource,
        triggerKey: run.triggerKey,
        status: run.status,
        costUsd: run.costUsd,
        worktreePath: run.worktreePath,
        prUrl: run.prUrl,
        headless: a.action.headless,
        ...extra,
      },
      result,
      error,
    });
  }

  function auditUser(action: string, target: string, params: Record<string, unknown>): void {
    ctx.audit.record({ actor: 'user', actorDetail: null, action, target, params, result: 'ok', error: null });
  }

  function finishEarly(
    a: Automation,
    run: AutomationRunDetail,
    status: 'denied' | 'over_budget' | 'failed',
    reason: string,
  ): AutomationRunDetail {
    const r = update(run.id, {
      status,
      endedAt: nowIso(),
      summary: reason,
      error: status === 'failed' ? reason : null,
    });
    notify(a, r);
    audit(a, r, status === 'failed' ? 'error' : 'denied', reason);
    return r;
  }

  function guard(a: Automation, rendered: string): GuardResult {
    return checkAutomationGuards({
      masterEnabled: ctx.config().automations.enabled,
      renderedPrompt: rendered,
      projectId: a.action.projectId,
      denyList: ctx.denyList,
      usage: required(ctx.usage, 'usage'),
      monthSpendUsd: repo.monthSpend(ctx.db, a.id, monthStartIso(now())),
      budgetUsd: a.budgetUsd,
    });
  }

  function repoPath(a: Automation): string {
    const project = ctx.projects.get(a.action.projectId);
    if (!project) throw new ServiceError('not_found', 404, `project ${a.action.projectId} not found`);
    const path = a.action.repo ?? project.repos[0]?.path ?? project.pathPrefixes[0];
    if (!path)
      throw new ServiceError('validation_failed', 400, `project ${project.id} has no repository path`);
    return path;
  }

  async function prepareCwd(a: Automation, run: AutomationRunDetail): Promise<string> {
    const repoDir = repoPath(a);
    if (!a.action.useWorktree) return repoDir;
    const base = await defaultBranch(repoDir);
    const { view } = await required(ctx.worktrees, 'worktrees').createWith(
      {
        repo: repoDir,
        base,
        type: run.triggerSource === 'github' ? 'fix' : 'chore',
        ticket: run.vars.ticket ?? null,
        slug: `auto-${slugify(a.name)}-${run.id.slice(0, 6)}`,
      },
      { runSetup: false, actor: 'automation' },
    );
    return view.path;
  }

  async function finalize(a: Automation, runId: string, res: RunOutcome): Promise<AutomationRunDetail> {
    const run = repo.getRun(ctx.db, runId);
    if (!run) throw new ServiceError('not_found', 404, `automation run ${runId} not found`);
    let diff: AutomationRunDetail['diffStat'] = null;
    if (run.worktreePath) {
      try {
        diff = await diffStat(run.worktreePath, await defaultBranch(run.worktreePath));
      } catch {
        diff = null;
      }
    }
    const session = run.sessionPk ? ctx.sessions.getByPk(run.sessionPk) : null;
    const prUrl = findPrUrl(res.resultText) ?? session?.prs[0]?.url ?? null;
    let summary: string | null = redact(res.resultText).slice(0, 2000) || null;
    if (run.sessionPk && ctx.recaps && !res.isError) {
      try {
        summary = (await ctx.recaps.recap(run.sessionPk)).text;
      } catch {
        // keep the redacted result text
      }
    }
    const status = res.isError ? 'failed' : 'success';
    const error = res.timedOut
      ? `timed out after ${a.action.timeoutMin} min`
      : res.isError
        ? 'claude reported an error'
        : null;
    const updated = update(run.id, {
      status,
      endedAt: nowIso(),
      prUrl,
      diffStat: diff,
      summary,
      error,
      costUsd: res.costUsd ?? run.costUsd,
    });
    notify(a, updated);
    audit(a, updated, status === 'success' ? 'ok' : 'error', error);
    return updated;
  }

  async function executeHeadless(a: Automation, runId: string, cwd: string, p: Pending): Promise<void> {
    const res = await runner({
      command: ctx.config().resumeProfile.claudeCommand,
      cwd,
      prompt: p.prompt,
      model: a.action.model,
      permissionMode: a.action.planApproval ? 'plan' : 'acceptEdits',
      sessionId: randomUUID(),
      maxBudgetUsd: p.remainingUsd,
      timeoutMs: a.action.timeoutMin * 60_000,
      logFile: logPath(runId),
    });
    const sessionPk = res.sessionId ? `claude:${res.sessionId}` : null;
    const run = update(runId, { sessionPk, costUsd: res.costUsd, logPath: logPath(runId) });
    if (a.action.planApproval && !res.isError) {
      const waiting = update(run.id, {
        status: 'awaiting_approval',
        summary: redact(res.resultText).slice(0, 4000),
      });
      required(ctx.inbox, 'inbox').upsert({
        kind: 'plan_approval',
        scope: { domain: 'automation-run', id: run.id },
        sessionId: res.sessionId,
        projectId: a.action.projectId,
        ticket: run.vars.ticket ?? null,
        reason: `${a.name}: plan awaiting approval`,
        payload: {
          source: 'claude',
          id: res.sessionId,
          automationId: a.id,
          runId: run.id,
          plan: waiting.summary,
        },
      });
      audit(a, waiting, 'ok', null, { phase: 'plan' });
      return;
    }
    await finalize(a, run.id, res);
  }

  async function executePty(a: Automation, runId: string, cwd: string, p: Pending): Promise<void> {
    assertOwnedCapacity(ctx, a.action.projectId);
    const spawned = spawnClaudeSession(ctx, {
      cwd,
      prompt: p.prompt,
      model: a.action.model ?? null,
      args: automationClaudeArgs({ permissionMode: a.action.planApproval ? 'plan' : 'acceptEdits' }),
    });
    update(runId, { sessionPk: spawned.sessionPk, ptyId: spawned.ptyId });
    const outcome = await waitForPtyTurn(
      ctx.bus,
      spawned.sessionPk ?? '',
      spawned.ptyId,
      a.action.timeoutMin * 60_000,
    );
    if (outcome.kind === 'timeout') ctx.pty.kill(spawned.ptyId);
    const session = spawned.sessionPk ? ctx.sessions.getByPk(spawned.sessionPk) : null;
    const waitingForPlan = outcome.kind === 'done' && outcome.status === 'waiting' && a.action.planApproval;
    await finalize(a, runId, {
      resultText: waitingForPlan
        ? 'The session is waiting for plan approval in its terminal.'
        : (session?.awaySummary ?? session?.lastPrompt ?? ''),
      isError: outcome.kind === 'timeout' || (outcome.kind === 'exited' && outcome.code !== 0),
      timedOut: outcome.kind === 'timeout',
      costUsd: session?.usage.costUsd ?? null,
    });
  }

  async function execute(p: Pending): Promise<void> {
    let a: Automation | null = null;
    try {
      const run = update(p.runId, { status: 'running' });
      a = mustGet(run.automationId);
      const cwd = await prepareCwd(a, run);
      update(run.id, { worktreePath: a.action.useWorktree ? cwd : null });
      if (a.action.headless) await executeHeadless(a, run.id, cwd, p);
      else await executePty(a, run.id, cwd, p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const failed = update(p.runId, {
        status: 'failed',
        endedAt: nowIso(),
        error: msg,
        summary: `Failed: ${msg}`,
      });
      if (a) {
        notify(a, failed);
        audit(a, failed, 'error', msg);
      }
    }
  }

  function drain(): void {
    if (stopped) return;
    const max = ctx.config().automations.maxConcurrent;
    while (queue.length > 0 && active.size < max) {
      const next = queue.shift();
      if (!next) break;
      active.add(next.runId);
      void execute(next)
        .catch((err: unknown) => ctx.log.error({ err, runId: next.runId }, 'automation run failed to report'))
        .finally(() => {
          active.delete(next.runId);
          drain();
        });
    }
  }

  async function start(id: string, fire: TriggerFire): Promise<AutomationRunDetail | null> {
    const a = mustGet(id);
    const run = repo.insertRun(ctx.db, {
      id: randomUUID(),
      automationId: id,
      triggerKey: fire.key,
      triggerSource: fire.source,
      vars: fire.vars,
      startedAt: nowIso(),
      status: 'queued',
      rerunOf: fire.rerunOf ?? null,
    });
    if (!run) return null;
    emit(run);
    let rendered: string;
    try {
      rendered = required(ctx.templates, 'templates').render(a.action.templateId, fire.vars);
    } catch (e) {
      return finishEarly(a, run, 'failed', `Template error: ${(e as Error).message}`);
    }
    const g = guard(a, rendered);
    if (!g.ok) return finishEarly(a, run, g.status, g.reason);
    queue.push({ runId: run.id, prompt: buildAutomationPrompt(rendered), remainingUsd: g.remainingUsd });
    drain();
    return repo.getRun(ctx.db, run.id);
  }

  function waitFor(runId: string): Promise<AutomationRunDetail> {
    const r = repo.getRun(ctx.db, runId);
    if (!r) return Promise.reject(new ServiceError('not_found', 404, `automation run ${runId} not found`));
    if (TERMINAL.has(r.status)) return Promise.resolve(r);
    return new Promise((resolve) => {
      const list = waiters.get(runId) ?? [];
      list.push(resolve);
      waiters.set(runId, list);
    });
  }

  function save(input: Automation): Automation {
    const a = AutomationSchema.parse(input);
    if (a.trigger.type === 'cron') validateCron(a.trigger.cron);
    const saved = repo.upsertAutomation(ctx.db, a, nowIso());
    auditUser('settings.update', `automation:${saved.id}`, {
      op: 'save',
      name: saved.name,
      enabled: saved.enabled,
      trigger: saved.trigger.type,
    });
    for (const l of listeners) l(saved.id, saved);
    return saved;
  }

  function mustGetRun(runId: string): AutomationRunDetail {
    const run = repo.getRun(ctx.db, runId);
    if (!run) throw new ServiceError('not_found', 404, `automation run ${runId} not found`);
    return run;
  }

  function mustAwait(run: AutomationRunDetail): string {
    if (run.status !== 'awaiting_approval' || !run.sessionPk) {
      throw new ServiceError(
        'invalid_state',
        409,
        `run ${run.id} is not awaiting plan approval (status ${run.status})`,
      );
    }
    return run.sessionPk;
  }

  function resolvePlanItem(runId: string): void {
    required(ctx.inbox, 'inbox').resolve({
      kind: 'plan_approval',
      scope: { domain: 'automation-run', id: runId },
    });
  }

  async function approve(runId: string): Promise<AutomationRunDetail> {
    const run = mustGetRun(runId);
    const pk = mustAwait(run);
    const a = mustGet(run.automationId);
    resolvePlanItem(run.id);
    auditUser('automation.approve', `automation-run:${run.id}`, { automationId: a.id, sessionPk: pk });

    let rendered: string;
    try {
      rendered = required(ctx.templates, 'templates').render(a.action.templateId, run.vars);
    } catch (e) {
      return finishEarly(a, run, 'failed', `Template error: ${(e as Error).message}`);
    }
    const g = guard(a, rendered);
    if (!g.ok) return finishEarly(a, run, g.status, g.reason);
    const planVerdict = ctx.denyList.check(run.summary ?? '', a.action.projectId);
    if (planVerdict.denied) {
      return finishEarly(
        a,
        run,
        'denied',
        `The plan matches the deny-list: ${planVerdict.reason ?? 'matched'}`,
      );
    }

    update(run.id, { status: 'running' });
    active.add(run.id);
    try {
      const res = await runner({
        command: ctx.config().resumeProfile.claudeCommand,
        cwd: run.worktreePath ?? repoPath(a),
        prompt: APPROVAL_PROMPT,
        model: a.action.model,
        permissionMode: 'acceptEdits',
        resumeSessionId: splitPk(pk).id,
        maxBudgetUsd: g.remainingUsd,
        timeoutMs: a.action.timeoutMin * 60_000,
        logFile: logPath(run.id),
      });
      return await finalize(a, run.id, { ...res, costUsd: (run.costUsd ?? 0) + (res.costUsd ?? 0) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const failed = update(run.id, {
        status: 'failed',
        endedAt: nowIso(),
        error: msg,
        summary: `Failed: ${msg}`,
      });
      notify(a, failed);
      audit(a, failed, 'error', msg, { phase: 'implement' });
      return failed;
    } finally {
      active.delete(run.id);
      drain();
    }
  }

  function reject(runId: string): AutomationRunDetail {
    const run = mustGetRun(runId);
    mustAwait(run);
    resolvePlanItem(run.id);
    auditUser('automation.reject', `automation-run:${run.id}`, { automationId: run.automationId });
    return update(run.id, {
      status: 'failed',
      endedAt: nowIso(),
      summary: 'Plan rejected by user',
      error: null,
    });
  }

  async function rerun(runId: string): Promise<AutomationRunDetail | null> {
    const run = mustGetRun(runId);
    return start(run.automationId, {
      key: `rerun:${randomUUID()}`,
      source: 'rerun',
      vars: run.vars,
      rerunOf: run.id,
    });
  }

  const api: AutomationServiceImpl = {
    list: () => repo.listAutomations(ctx.db),
    get: (id) => repo.getAutomation(ctx.db, id),
    listWithStats: () =>
      repo.listAutomations(ctx.db).map((a) => ({
        ...a,
        stats: repo.runStats(ctx.db, a.id, monthStartIso(now())),
        nextRunAt: nextRunAt(a, now()),
      })),
    save,
    remove(id) {
      mustGet(id);
      repo.deleteAutomation(ctx.db, id);
      auditUser('settings.update', `automation:${id}`, { op: 'delete' });
      for (const l of listeners) l(id, null);
    },
    setEnabled(id, enabled) {
      const a = mustGet(id);
      return save({ ...a, enabled });
    },
    start,
    approve,
    reject,
    rerun,
    async runNow(id) {
      const r = await start(id, { key: `manual:${randomUUID()}`, source: 'manual', vars: {} });
      if (!r) throw new ServiceError('invalid_state', 409, 'manual run was not created');
      return waitFor(r.id);
    },
    runs: (id) => repo.listRuns(ctx.db, id),
    run: (runId) => repo.getRun(ctx.db, runId),
    waitFor,
    logLines(runId) {
      const path = repo.getRunLogPath(ctx.db, runId);
      if (!path || !existsSync(path)) return [];
      return readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => (l.trim() ? formatStreamLine(l) : null))
        .filter((l): l is string => l !== null)
        .slice(-2000);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
  };
  return api;
}
