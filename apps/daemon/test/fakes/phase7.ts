import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LaunchRequest } from '@orc/api-contract';
import { OrcConfig, type ProjectConfig } from '@orc/api-contract';
import {
  type AuditActor,
  type AuditEntry,
  checkDenied,
  DEFAULT_DENY_PATTERNS,
  emptyUsage,
  type InboxItem,
  type LiveState,
  type Recap,
  type Session,
  type UsageSnapshot,
  type Worktree,
  type WorktreeView,
} from '@orc/core';
import { execa } from 'execa';
import { type InboxEngineRuntime, inboxDedupeKey } from '../../src/inbox/engine.ts';
import type { Phase7Options } from '../../src/phase7.ts';
import type { PtyInfo, PtyManager } from '../../src/pty/pty-manager.ts';
import type { AuditService } from '../../src/services/audit/audit.ts';
import type { HeadlessRunOptions, HeadlessRunResult } from '../../src/services/automations/headless.ts';
import { ServiceError } from '../../src/services/errors.ts';
import type { LaunchService } from '../../src/services/launch.ts';
import type { ProjectServiceImpl } from '../../src/services/projects.ts';
import type { RecapService } from '../../src/services/recap/recap.ts';
import type { DenyList } from '../../src/services/safety/deny-list.ts';
import type { ScheduledJob, Scheduler } from '../../src/services/scheduler/scheduler.ts';
import { createMemorySecretStore } from '../../src/services/secrets/secret-store.ts';
import { type SessionListItem, type SessionService, sessionPk } from '../../src/services/sessions.ts';
import type { ShipService } from '../../src/services/ship/ship.ts';
import type { Template, TemplateRegistry } from '../../src/services/templates.ts';
import type { UsageMeter } from '../../src/services/usage/meter.ts';
import type { CreateWorktreeInput, WorktreeService } from '../../src/services/worktree/worktree.ts';
import { fakeAgncFactory, makeFakeAgncState } from './agnc-server.ts';

const iso = () => new Date().toISOString();

export function testConfig(input: Record<string, unknown> = {}): OrcConfig {
  return OrcConfig.parse({
    projects: [
      {
        id: 'wakecap',
        name: 'Wakecap',
        pathPrefixes: [mkdtempSync(join(tmpdir(), 'orc-p7-proj-'))],
        ticketRegex: '\\b(SAF|SUPRT)-\\d+\\b',
        maxConcurrentOwned: 3,
      },
    ],
    ...input,
  });
}

export async function initGitRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'orc-p7-git-'));
  await execa('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  await execa('git', ['-C', repo, 'add', '.']);
  await execa('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return repo;
}

export function makeSession(o: Partial<Session> & { id: string }): Session {
  return {
    source: 'claude',
    projectId: 'wakecap',
    startCwd: '/tmp',
    cwds: ['/tmp'],
    name: null,
    firstPrompt: null,
    lastPrompt: null,
    awaySummary: null,
    recap: null,
    startedAt: '2026-09-17T08:00:00.000Z',
    lastActivityAt: '2026-09-17T08:30:00.000Z',
    models: [],
    permissionMode: null,
    usage: emptyUsage(),
    linesAdded: null,
    linesRemoved: null,
    prs: [],
    tickets: [],
    skills: [],
    mcpServers: [],
    filesTouched: [],
    promptCount: 0,
    toolCallCount: 0,
    apiErrorCount: 0,
    flags: { touchedProd: false, hasSubagents: false, automated: false },
    availability: 'resumable',
    transcriptPath: null,
    lastTest: null,
    live: null,
    ...o,
  };
}

export function makeLive(o: Partial<LiveState> = {}): LiveState {
  return {
    pid: 4242,
    status: 'waiting',
    waitingFor: 'input needed',
    since: '2026-09-17T08:30:00.000Z',
    ownership: 'owned',
    ptyId: 'pty-1',
    stage: null,
    currentTool: null,
    backgroundJobs: 0,
    runningSubagents: 0,
    contextFill: null,
    ...o,
  };
}

function toListItem(s: Session): SessionListItem {
  return {
    pk: sessionPk(s.source, s.id),
    source: s.source,
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    firstPrompt: s.firstPrompt,
    lastPrompt: s.lastPrompt,
    recap: s.recap,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    durationMs: Date.parse(s.lastActivityAt) - Date.parse(s.startedAt),
    costUsd: s.usage.costUsd,
    tickets: s.tickets,
    prs: s.prs,
    availability: s.availability,
    pinned: false,
    labels: [],
    live: s.live,
    snippet: null,
  };
}

export function fakeSessions(
  list: Session[] = [],
): SessionService & { byPk: Map<string, Session>; add(s: Session): void } {
  const byPk = new Map(list.map((s) => [sessionPk(s.source, s.id), s] as const));
  return {
    byPk,
    add(s) {
      byPk.set(sessionPk(s.source, s.id), s);
    },
    list(q) {
      const items = [...byPk.values()]
        .filter((s) => !q.projectId || s.projectId === q.projectId)
        .map(toListItem);
      return { items: items.slice(0, q.limit ?? 50), nextCursor: null };
    },
    get: (source, id) => byPk.get(sessionPk(source, id)) ?? null,
    getByPk: (pk) => byPk.get(pk) ?? null,
    events: () => ({ items: [], nextSeq: null }),
    agents: () => [],
    setLive(pk, live) {
      const s = byPk.get(pk);
      if (s) s.live = live;
    },
    resume: async () => ({ launched: 'external' as const, command: 'claude --resume' }),
  };
}

export function fakeProjects(cfg: OrcConfig): ProjectServiceImpl {
  return {
    list: () =>
      cfg.projects.map((p) => ({
        id: p.id,
        name: p.name,
        pathPrefixes: p.pathPrefixes,
        hidden: p.hidden,
        lastActivityAt: null,
        sessionCount: 0,
      })),
    resolve: (cwd) => cfg.projects.find((p) => p.pathPrefixes.some((pre) => cwd.startsWith(pre)))?.id ?? null,
    get: (id) => cfg.projects.find((p) => p.id === id) ?? null,
    update: (id, patch) => {
      const p = cfg.projects.find((x) => x.id === id);
      if (!p) throw new ServiceError('not_found', 404, `unknown project ${id}`);
      const { features, ...rest } = patch;
      Object.assign(p, rest);
      if (features) Object.assign(p.features, features);
      return p as ProjectConfig;
    },
    ensureDefaults() {},
    ensureDetected: () => ({ added: [] }),
    deriveConfigFor: () => ({ ticketRegex: null, prodPatterns: [] }),
    syncTable() {},
  };
}

export type FakePty = PtyManager & {
  spawned: PtyInfo[];
  sent: Array<{ id: string; text: string }>;
  killed: string[];
  exit(id: string, code?: number): void;
};

export function createFakePty(): FakePty {
  const spawned: PtyInfo[] = [];
  const sent: Array<{ id: string; text: string }> = [];
  const killed: string[] = [];
  const get = (id: string) => spawned.find((p) => p.id === id);
  return {
    spawned,
    sent,
    killed,
    exit(id, code = 0) {
      const p = get(id);
      if (p) {
        p.exitedAt = iso();
        p.exitCode = code;
      }
    },
    spawn(opts) {
      const info: PtyInfo = {
        id: `pty-${spawned.length + 1}`,
        sessionPk: opts.sessionPk ?? null,
        command: opts.command,
        args: opts.args,
        cwd: opts.cwd,
        pid: 1000 + spawned.length,
        startedAt: iso(),
        exitedAt: null,
        exitCode: null,
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 36,
      };
      spawned.push(info);
      return info;
    },
    write() {},
    async sendText(id, text) {
      sent.push({ id, text });
    },
    resize() {},
    kill(id) {
      killed.push(id);
      const p = get(id);
      if (p) p.exitedAt = iso();
    },
    attach: () => ({ scrollback: '', detach() {} }),
    list: () => spawned,
    get,
    remove(id) {
      const i = spawned.findIndex((p) => p.id === id);
      if (i >= 0) spawned.splice(i, 1);
    },
    disposeAll() {},
  };
}

export function fakeInbox(): InboxEngineRuntime & { items: InboxItem[]; resolved: string[] } {
  const items: InboxItem[] = [];
  const resolved: string[] = [];
  const find = (id: string): InboxItem => {
    const it = items.find((i) => i.id === id);
    if (!it) throw new Error(`inbox item ${id} not found`);
    return it;
  };
  return {
    items,
    resolved,
    upsert(u) {
      const dedupeKey = inboxDedupeKey(u);
      const existing = items.find(
        (i) => i.dedupeKey === dedupeKey && (i.state === 'open' || i.state === 'snoozed'),
      );
      if (existing) {
        existing.reason = u.reason;
        existing.payload = u.payload ?? {};
        existing.updatedAt = iso();
        return existing;
      }
      const item: InboxItem = {
        id: randomUUID(),
        kind: u.kind,
        sessionId: u.sessionId ?? null,
        projectId: u.projectId ?? null,
        ticket: u.ticket ?? null,
        reason: u.reason,
        dedupeKey,
        createdAt: iso(),
        updatedAt: iso(),
        state: 'open',
        snoozeUntil: null,
        payload: u.payload ?? {},
      };
      items.push(item);
      return item;
    },
    resolve(key) {
      const dedupeKey = inboxDedupeKey(key);
      resolved.push(dedupeKey);
      for (const i of items) if (i.dedupeKey === dedupeKey && i.state === 'open') i.state = 'auto_resolved';
    },
    list: (f) =>
      items.filter(
        (i) =>
          (!f.state || f.state.includes(i.state)) &&
          (!f.kind || f.kind.includes(i.kind)) &&
          (!f.projectId || i.projectId === f.projectId),
      ),
    markDone(id) {
      const i = find(id);
      i.state = 'done';
      return i;
    },
    snooze(id, until) {
      const i = find(id);
      i.state = 'snoozed';
      i.snoozeUntil = until;
      return i;
    },
    reopen(id) {
      const i = find(id);
      i.state = 'open';
      return i;
    },
    registerRule() {},
    tick() {},
    start() {},
    stop() {},
  };
}

export function fakeAudit(): AuditService & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record(e) {
      const full: AuditEntry = { ...e, id: randomUUID(), ts: iso() };
      entries.push(full);
      return full;
    },
    list: (f) =>
      entries
        .filter((x) => (!f.action || x.action === f.action) && (!f.actor || x.actor === f.actor))
        .slice(0, f.limit ?? 1000),
  };
}

export function fakeUsage(state: { ok: boolean } = { ok: true }): UsageMeter & { state: { ok: boolean } } {
  const snap: UsageSnapshot = {
    source: 'estimate',
    generatedAt: iso(),
    block: { active: true, start: iso(), end: iso(), tokens: 1000, costUsd: 3, pctOfLimit: 0.2 },
    week: { tokens: 10000, costUsd: 30, pctOfLimit: 0.3 },
    burnRateUsdPerHour: 2.5,
    burnRateTokensPerMin: 400,
    projectedBlockExhaustionAt: null,
  };
  return {
    state,
    snapshot: () => snap,
    refresh: () => snap,
    ingestOfficial: () => null,
    budgets: () => [],
    contextFill: () => null,
    concurrency: () => [],
    start() {},
    stop() {},
    checkBudget: () => ({ ok: state.ok, pct: state.ok ? 0.2 : 1.1, limitUsd: 50 }),
  };
}

export function fakeDenyList(): DenyList {
  return { check: (text) => checkDenied(text, DEFAULT_DENY_PATTERNS) };
}

export function fakeRecaps(
  text = 'Fixed the flaky test and opened a draft PR.',
): RecapService & { calls: string[] } {
  const calls: string[] = [];
  const recap: Recap = {
    id: 'rec-1',
    kind: 'session',
    targetKey: 'claude:x',
    transcriptOffset: 0,
    model: 'claude-haiku-4-5',
    engine: 'claude-cli',
    text,
    costUsd: 0.01,
    inputTokensApprox: 1000,
    createdAt: iso(),
  };
  return {
    calls,
    async recap(pk) {
      calls.push(pk);
      return { text, costUsd: 0.01, model: 'claude-haiku-4-5', cached: false };
    },
    async daily() {
      return '';
    },
    latest: () => recap,
    latestDaily: () => null,
    findCached: () => null,
    async runLlm() {
      return recap;
    },
    monthSpend: () => ({ spentUsd: 0, budgetUsd: 20 }),
    syncSchedule() {},
    start() {},
    stop() {},
  };
}

export function fakeWorktrees(): WorktreeService & {
  created: WorktreeView[];
  dirty: Set<string>;
  archived: Array<{ path: string; actor: AuditActor }>;
} {
  const root = mkdtempSync(join(tmpdir(), 'orc-p7-wt-'));
  const created: WorktreeView[] = [];
  const dirty = new Set<string>();
  const archived: Array<{ path: string; actor: AuditActor }> = [];
  const branchName = (i: Pick<CreateWorktreeInput, 'type' | 'ticket' | 'slug'>) =>
    `${i.type}/${i.ticket ? `${i.ticket}-` : ''}${i.slug.replace(/\s+/g, '-')}`;
  const make = (i: CreateWorktreeInput): WorktreeView => {
    const path = join(root, i.slug.replace(/\s+/g, '-'));
    mkdirSync(path, { recursive: true });
    const base: Worktree = {
      path,
      repo: i.repo,
      branch: branchName(i),
      base: i.base,
      ticket: i.ticket,
      dirty: false,
      prUrl: null,
      state: 'active',
      createdByApp: true,
    };
    return {
      ...base,
      head: null,
      isMain: false,
      origin: 'app',
      sessionPks: [],
      projectId: 'wakecap',
      prStatus: null,
      repoSlug: null,
      updatedAt: iso(),
    };
  };
  const archiveAs = async (path: string, actor: AuditActor) => {
    if (dirty.has(path))
      throw new ServiceError('dirty_worktree', 409, `worktree ${path} has uncommitted changes`);
    archived.push({ path, actor });
    const wt = created.find((w) => w.path === path);
    if (wt) wt.state = 'archived';
  };
  return {
    created,
    dirty,
    archived,
    async discover() {
      return created;
    },
    async create(i) {
      const v = make(i);
      created.push(v);
      return v;
    },
    async createWith(i) {
      const v = make(i);
      created.push(v);
      return { view: v, setupPtyId: null };
    },
    async runScript() {
      return { ptyId: 'pty-script' };
    },
    async syncToMain() {
      return { files: 0 };
    },
    async syncPreview(path) {
      return { path, mainPath: path, files: [], mainDirty: [] };
    },
    archive: (path) => archiveAs(path, 'user'),
    archiveAs,
    list: () => created,
    get: (path) => created.find((w) => w.path === path) ?? null,
    findByCwd: (cwd) =>
      created
        .filter((w) => w.state === 'active' && cwd.startsWith(w.path))
        .sort((a, b) => b.path.length - a.path.length)[0] ?? null,
    async open() {},
    async cleanupPreview() {
      return { candidates: [], skipped: [] };
    },
    async cleanup(paths) {
      return { results: paths.map((path) => ({ path, ok: false, error: 'not supported by the fake' })) };
    },
    branchName,
  };
}

export function fakeLauncher(opts: { max?: number } = {}): LaunchService & { requests: LaunchRequest[] } {
  const requests: LaunchRequest[] = [];
  return {
    requests,
    async launch(req) {
      if (requests.length >= (opts.max ?? 99)) {
        throw new ServiceError('capacity_exceeded', 409, 'too many owned sessions', { max: opts.max });
      }
      requests.push(req);
      const n = requests.length;
      return { ptyId: `pty-l${n}`, sessionId: req.source === 'claude' ? `launched-${n}` : null };
    },
    async kill() {
      return { killed: 'pty' as const };
    },
    ownedCount: () => requests.length,
  };
}

export function fakeTemplates(map: Record<string, string>): TemplateRegistry {
  const list: Template[] = Object.entries(map).map(([id, prompt]) => ({
    id,
    kind: 'workflow',
    label: id,
    prompt,
    vars: [],
    defaultSource: 'claude',
    projectIds: 'all',
  }));
  return {
    list: () => list,
    render(id, vars) {
      const t = map[id];
      if (t === undefined) throw new Error(`unknown template ${id}`);
      return t.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
    },
  };
}

export function fakeShip(): ShipService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async commit() {
      calls.push('commit');
      return { sha: 'abc123' };
    },
    async push() {
      calls.push('push');
    },
    async createPr() {
      calls.push('createPr');
      return { repo: 'example-org/svc', number: 1, url: 'https://github.com/example-org/svc/pull/1' };
    },
    async merge() {
      calls.push('merge');
    },
    async suggest() {
      calls.push('suggest');
      return {
        message: 'chore: update',
        title: 'chore: update',
        body: '',
        base: 'main',
        branch: 'feat/x',
        ticket: null,
      };
    },
    async backmerge() {
      calls.push('backmerge');
      return { ptyId: 'pty-backmerge' };
    },
  };
}

/** In-memory stand-in for P5's persisted Scheduler: it stores jobs and fires them only when a test says so. */
export function createMemoryScheduler(): Scheduler & {
  jobs: ScheduledJob[];
  fire(kind: ScheduledJob['kind'], job: ScheduledJob): Promise<void>;
} {
  const jobs: ScheduledJob[] = [];
  const handlers = new Map<ScheduledJob['kind'], Array<(job: ScheduledJob) => Promise<void>>>();
  return {
    jobs,
    add(job) {
      const full: ScheduledJob = { ...job, id: randomUUID() };
      jobs.push(full);
      return full;
    },
    remove(id) {
      const i = jobs.findIndex((j) => j.id === id);
      if (i >= 0) jobs.splice(i, 1);
    },
    list: (kind) => jobs.filter((j) => !kind || j.kind === kind),
    get: (id) => jobs.find((j) => j.id === id) ?? null,
    onFire(kind, fn) {
      handlers.set(kind, [...(handlers.get(kind) ?? []), fn]);
    },
    start() {},
    stop() {},
    async fire(kind, job) {
      for (const fn of handlers.get(kind) ?? []) await fn(job);
    },
  };
}

/**
 * Phase 7 overrides for every `createDaemon` in tests and the e2e fixture daemon: a headless runner
 * that writes one assistant line to the run log and never spawns `claude`, no `git diff` for
 * TODO suggestions, a supervisor classifier that always escalates without spawning `claude`, and
 * AGNC on the in-memory fake server with the memory secret store (never the network or the Keychain).
 */
export function offlinePhase7(): Phase7Options {
  return {
    runner: async (r: HeadlessRunOptions): Promise<HeadlessRunResult> => {
      mkdirSync(dirname(r.logFile), { recursive: true });
      writeFileSync(
        r.logFile,
        `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'offline run' }] } })}\n`,
      );
      return {
        sessionId: r.resumeSessionId ?? r.sessionId ?? randomUUID(),
        costUsd: 0,
        durationMs: 1,
        numTurns: 1,
        resultText: r.permissionMode === 'plan' ? 'Plan: offline' : 'offline run',
        isError: false,
        subtype: 'success',
        timedOut: false,
        exitCode: 0,
        events: 1,
        stderrTail: '',
      };
    },
    addedLines: async () => '',
    agnc: { factory: fakeAgncFactory(makeFakeAgncState()), secrets: createMemorySecretStore() },
    classifier: async (i) => ({
      output: { decision: 'escalate', answer: null, confidence: 0, reason: 'offline classifier' },
      costUsd: 0,
      model: i.model,
      durationMs: 1,
    }),
  };
}
