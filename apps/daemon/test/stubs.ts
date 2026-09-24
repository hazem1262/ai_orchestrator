import { randomUUID } from 'node:crypto';
import type { AuditEntry, InboxItem, Session } from '@orc/core';
import { emptyUsage } from '@orc/core';
import { type InboxEngine, type InboxRule, type InboxUpsert, inboxDedupeKey } from '../src/inbox/engine.ts';
import type { AuditService } from '../src/services/audit/audit.ts';
import { type SessionService, sessionPk } from '../src/services/sessions.ts';
import type { TemplateRegistry } from '../src/services/templates.ts';

export function makeSession(p: Partial<Session> & { id: string }): Session {
  const now = '2026-09-17T10:00:00.000Z';
  return {
    source: 'claude',
    projectId: 'wakecap',
    startCwd: '/tmp',
    cwds: [p.startCwd ?? '/tmp'],
    name: null,
    firstPrompt: null,
    lastPrompt: null,
    awaySummary: null,
    recap: null,
    startedAt: now,
    lastActivityAt: now,
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
    ...p,
  };
}

export function stubSessions(
  sessions: Session[],
  opts: { onResume?: (id: string) => void } = {},
): SessionService & { sessions: Session[] } {
  const byPk = (pk: string) => sessions.find((s) => sessionPk(s.source, s.id) === pk) ?? null;
  return {
    sessions,
    list: () => ({
      items: sessions.map((s) => ({
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
        durationMs: 0,
        costUsd: s.usage.costUsd,
        tickets: s.tickets,
        prs: s.prs,
        availability: s.availability,
        pinned: false,
        labels: [],
        live: s.live,
        snippet: null,
      })),
      nextCursor: null,
    }),
    get: (source, id) => sessions.find((s) => s.source === source && s.id === id) ?? null,
    getByPk: byPk,
    events: () => ({ items: [], nextSeq: null }),
    agents: () => [],
    setLive: (pk, live) => {
      const s = byPk(pk);
      if (s) s.live = live;
    },
    resume: async (_source, id) => {
      opts.onResume?.(id);
      return { ptyId: `pty-resume-${id}` };
    },
  };
}

export function recordingInbox(): InboxEngine & {
  upserts: InboxUpsert[];
  resolved: string[];
  rules: InboxRule[];
} {
  const upserts: InboxUpsert[] = [];
  const resolved: string[] = [];
  const rules: InboxRule[] = [];
  const items = new Map<string, InboxItem>();
  // Shipped InboxUpsert (contracts §11) carries no dedupeKey; the engine composes it from kind/scope/facet.
  const toItem = (u: InboxUpsert, dedupeKey: string): InboxItem => ({
    id: items.get(dedupeKey)?.id ?? randomUUID(),
    kind: u.kind,
    sessionId: u.sessionId ?? null,
    projectId: u.projectId ?? null,
    ticket: u.ticket ?? null,
    reason: u.reason,
    dedupeKey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: 'open',
    snoozeUntil: null,
    payload: u.payload ?? {},
  });
  const find = (id: string) => {
    const it = [...items.values()].find((i) => i.id === id);
    if (!it) throw new Error('not_found');
    return it;
  };
  return {
    upserts,
    resolved,
    rules,
    upsert(u) {
      upserts.push(u);
      const dedupeKey = inboxDedupeKey(u);
      const item = toItem(u, dedupeKey);
      items.set(dedupeKey, item);
      return item;
    },
    resolve(key) {
      const dedupeKey = inboxDedupeKey(key);
      resolved.push(dedupeKey);
      const it = items.get(dedupeKey);
      if (it) items.set(dedupeKey, { ...it, state: 'auto_resolved' });
    },
    list: (f) =>
      [...items.values()]
        .filter((i) => !f.state || f.state.includes(i.state))
        .filter((i) => !f.kind || f.kind.includes(i.kind)),
    markDone: (id) => ({ ...find(id), state: 'done' }),
    snooze: (id, until) => ({ ...find(id), state: 'snoozed', snoozeUntil: until }),
    reopen: (id) => ({ ...find(id), state: 'open' }),
    registerRule: (r) => {
      rules.push(r);
    },
  };
}

export function stubTemplates(): TemplateRegistry {
  const prompts: Record<string, string> = {
    backmerge: '/backmerge {{ticket}}',
    'preset-fix-ci': 'Fix the failing CI check {{check}} on {{prUrl}}',
    'preset-address-comments': 'Address the review comments on {{prUrl}}',
  };
  return {
    list: () =>
      Object.entries(prompts).map(([id, prompt]) => ({
        id,
        kind: id.startsWith('preset-') ? ('preset' as const) : ('workflow' as const),
        label: id,
        prompt,
        vars: [],
        defaultSource: 'claude' as const,
        projectIds: 'all' as const,
      })),
    render: (id, vars) => {
      const tpl = prompts[id];
      if (tpl === undefined) throw new Error(`unknown template ${id}`);
      return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
    },
  };
}

export function memoryAudit(): AuditService & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record(e) {
      const full: AuditEntry = { ...e, id: randomUUID(), ts: new Date().toISOString() };
      entries.push(full);
      return full;
    },
    list: (f) => entries.filter((e) => !f.action || e.action === f.action),
  };
}
