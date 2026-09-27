import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OrcConfig, ProjectConfig } from '@orc/api-contract';
import { type AgentNode, emptyUsage, type Session, type TimelineEvent } from '@orc/core';
import { afterEach } from 'vitest';
import type { DaemonContext } from '../src/context.ts';
import type { EventBus } from '../src/live/event-bus.ts';
import type { ProjectService } from '../src/services/projects.ts';
import {
  type SessionListItem,
  type SessionListQuery,
  type SessionService,
  sessionPk,
} from '../src/services/sessions.ts';
import { createTestContext, type TestContext } from './helpers.ts';

export function makeSession(p: Partial<Session> & { id: string }): Session {
  return {
    source: 'claude',
    projectId: 'wakecap',
    startCwd: '/Users/test/Wakecap',
    cwds: ['/Users/test/Wakecap'],
    name: null,
    firstPrompt: null,
    lastPrompt: null,
    awaySummary: null,
    recap: null,
    startedAt: '2026-09-01T09:00:00.000Z',
    lastActivityAt: '2026-09-01T10:00:00.000Z',
    models: ['claude-opus-5'],
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
    ...p,
  };
}

export function ev(
  p: Partial<TimelineEvent> & { seq: number; ts: string; kind: TimelineEvent['kind'] },
): TimelineEvent {
  return {
    sessionId: 's',
    agentId: null,
    uuid: `u-${p.agentId ?? 'main'}-${p.seq}`,
    parentUuid: null,
    turn: 1,
    text: null,
    tool: null,
    toolUseId: null,
    mcpServer: null,
    input: null,
    messageId: null,
    model: null,
    usage: null,
    durationMs: null,
    ...p,
  };
}

export interface FakeSessionData {
  sessions: Session[];
  events?: Record<string, TimelineEvent[]>;
  agents?: Record<string, AgentNode[]>;
}

function toItem(s: Session): SessionListItem {
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

export function fakeSessions(data: FakeSessionData, bus?: EventBus): SessionService {
  const find = (pk: string) => data.sessions.find((s) => sessionPk(s.source, s.id) === pk) ?? null;
  return {
    list(q: SessionListQuery) {
      const items = data.sessions
        .filter(
          (s) =>
            (q.projectId === undefined || s.projectId === q.projectId) &&
            (q.from === undefined || s.lastActivityAt >= q.from) &&
            (q.to === undefined || s.startedAt <= q.to) &&
            (q.ticket === undefined || s.tickets.includes(q.ticket)) &&
            (q.pr === undefined || s.prs.some((p) => p.url === q.pr)) &&
            (q.source === undefined || s.source === q.source),
        )
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      const start = q.cursor ? Number(q.cursor) : 0;
      const limit = q.limit ?? 50;
      return {
        items: items.slice(start, start + limit).map(toItem),
        nextCursor: start + limit < items.length ? String(start + limit) : null,
      };
    },
    get: (source, id) => find(sessionPk(source, id)),
    getByPk: (pk) => find(pk),
    events(source, id, opts) {
      const all = (data.events?.[sessionPk(source, id)] ?? [])
        .filter((e) => e.agentId === (opts.agentId ?? null))
        .filter((e) => e.seq > (opts.afterSeq ?? 0))
        .sort((a, b) => a.seq - b.seq);
      const limit = Math.min(opts.limit ?? 200, 500);
      const items = all.slice(0, limit);
      return { items, nextSeq: all.length > limit ? (items.at(-1)?.seq ?? null) : null };
    },
    agents: (source, id) => data.agents?.[sessionPk(source, id)] ?? [],
    setLive(pk, live) {
      const s = find(pk);
      if (!s) return;
      s.live = live;
      bus?.emit({ type: 'session.updated', session: s });
    },
    async resume() {
      throw new Error('resume is not available in fakeSessions');
    },
  };
}

export function fakeProjects(cfg: () => OrcConfig): ProjectService {
  const matches = (cwd: string, prefix: string) =>
    cwd === prefix || cwd.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
  return {
    list: () =>
      cfg().projects.map((p) => ({
        id: p.id,
        name: p.name,
        pathPrefixes: p.pathPrefixes,
        hidden: p.hidden,
        lastActivityAt: null,
        sessionCount: 0,
      })),
    resolve(cwd) {
      let best: { id: string; len: number } | null = null;
      for (const p of cfg().projects) {
        for (const pre of p.pathPrefixes) {
          if (matches(cwd, pre) && (best === null || pre.length > best.len))
            best = { id: p.id, len: pre.length };
        }
      }
      return best?.id ?? null;
    },
    get: (id) => cfg().projects.find((p) => p.id === id) ?? null,
    update() {
      throw new Error('update is not available in fakeProjects');
    },
  };
}

export const WAKECAP_TICKETS = '\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b';

export function withWakecap(prefix: string, extra: Partial<ProjectConfig> = {}): (c: OrcConfig) => OrcConfig {
  return (c) => ({
    ...c,
    projects: [
      ProjectConfig.parse({
        id: 'wakecap',
        name: 'Wakecap',
        pathPrefixes: [prefix],
        ticketRegex: WAKECAP_TICKETS,
        features: { workStreams: true, prodBadges: true, recaps: true },
        ...extra,
      }),
    ],
  });
}

export interface P5TestContext {
  ctx: TestContext;
  headers: Record<string, string>;
  token: string;
  dispose(): void;
}

const liveContexts: TestContext[] = [];
/** Every context made in a test file is disposed after each test (temp homes, db handles). */
afterEach(() => {
  for (const c of liveContexts.splice(0)) c.dispose();
});

export function makeP5Context(
  opts: {
    overrides?: Partial<DaemonContext>;
    config?: (c: OrcConfig) => OrcConfig;
    data?: FakeSessionData;
  } = {},
): P5TestContext {
  const base = createTestContext(opts.overrides ?? {});
  liveContexts.push(base);
  let cfg = OrcConfig.parse(opts.config ? opts.config(base.config()) : base.config());
  const ctx: TestContext = { ...base, config: () => cfg };
  // Keep P1's ProjectServiceImpl extras (ensureDefaults, deriveConfigFor, …) and override the lookups.
  ctx.projects = Object.assign(
    Object.create(base.projects) as typeof base.projects,
    fakeProjects(() => cfg),
  );
  ctx.updateConfig = (fn) => {
    cfg = OrcConfig.parse(fn(cfg));
    ctx.bus.emit({ type: 'config.changed' });
    return cfg;
  };
  if (opts.data) ctx.sessions = fakeSessions(opts.data, ctx.bus);
  mkdirSync(dirname(ctx.paths.tokenFile), { recursive: true });
  if (!existsSync(ctx.paths.tokenFile)) writeFileSync(ctx.paths.tokenFile, 'test-token-p5', { mode: 0o600 });
  const token = readFileSync(ctx.paths.tokenFile, 'utf8').trim();
  return {
    ctx,
    token,
    headers: { 'x-orc-token': token, 'content-type': 'application/json' },
    dispose: () => base.dispose(),
  };
}
