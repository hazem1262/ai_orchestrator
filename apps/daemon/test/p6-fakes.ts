import { randomUUID } from 'node:crypto';
import { OrcConfig } from '@orc/api-contract';
import { emptyUsage, type InboxItem, type LiveState, type Session } from '@orc/core';
import type { OrcApp } from '../src/http/types.ts';
import { type InboxEngineRuntime, inboxDedupeKey } from '../src/inbox/engine.ts';
import type { EventBus } from '../src/live/event-bus.ts';
import type { Notifier, NotifyChannelImpl } from '../src/notify/notifier.ts';
import { withPtyInputAudit } from '../src/pty/audited-pty.ts';
import type { PtyInfo, PtyManager } from '../src/pty/pty-manager.ts';
import type { AuditService } from '../src/services/audit/audit.ts';
import { type SessionService, sessionPk } from '../src/services/sessions.ts';
import { createTestContext } from './helpers.ts';

export const T0 = '2026-09-17T09:00:00.000Z';

export function makeP6Session(o: Partial<Session> & { id: string }): Session {
  return {
    source: 'claude',
    projectId: 'wakecap',
    startCwd: '/Users/test/Wakecap',
    cwds: ['/Users/test/Wakecap'],
    name: 'Test session',
    firstPrompt: 'check the tests',
    lastPrompt: 'continue?',
    awaySummary: null,
    recap: null,
    startedAt: T0,
    lastActivityAt: T0,
    models: ['claude-opus-5'],
    permissionMode: null,
    usage: emptyUsage(),
    linesAdded: null,
    linesRemoved: null,
    prs: [],
    tickets: ['SAF-1787'],
    skills: [],
    mcpServers: [],
    filesTouched: [],
    promptCount: 1,
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

export function ownedLive(ptyId = 'pty-1'): LiveState {
  return {
    pid: 4242,
    status: 'waiting',
    waitingFor: 'Proceed?',
    since: T0,
    ownership: 'owned',
    ptyId,
    stage: null,
    currentTool: null,
    backgroundJobs: 0,
    runningSubagents: 0,
    contextFill: null,
  };
}

export function makeInboxItem(o: Partial<InboxItem> & { id: string }): InboxItem {
  return {
    kind: 'waiting',
    sessionId: 's1',
    projectId: 'wakecap',
    ticket: 'SAF-1787',
    reason: 'Waiting for input: Proceed?',
    dedupeKey: 'waiting:claude:s1',
    createdAt: T0,
    updatedAt: T0,
    state: 'open',
    snoozeUntil: null,
    payload: { source: 'claude', id: 's1' },
    ...o,
  };
}

export function fakePty(): PtyManager & { sent: Array<{ id: string; text: string }> } {
  const sent: Array<{ id: string; text: string }> = [];
  const info = (id: string): PtyInfo => ({
    id,
    sessionPk: null,
    command: 'claude',
    args: [],
    cwd: '/Users/test/Wakecap',
    pid: 1,
    startedAt: T0,
    exitedAt: null,
    exitCode: null,
    cols: 120,
    rows: 40,
  });
  return {
    sent,
    spawn: (o) => ({ ...info('pty-new'), command: o.command, args: o.args, cwd: o.cwd }),
    write: () => {},
    sendText: async (id, text) => {
      sent.push({ id, text });
    },
    resize: () => {},
    kill: () => {},
    attach: () => ({ scrollback: '', detach: () => {} }),
    list: () => [],
    get: (id) => info(id),
    remove: () => {},
    disposeAll: () => {},
  };
}

export function fakeSessions(list: Session[]): SessionService {
  const byPk = (pk: string) => list.find((s) => sessionPk(s.source, s.id) === pk) ?? null;
  return {
    list: () => ({ items: [], nextCursor: null }),
    get: (source, id) => list.find((s) => s.source === source && s.id === id) ?? null,
    getByPk: byPk,
    events: () => ({ items: [], nextSeq: null }),
    agents: () => [],
    setLive: (pk, live) => {
      const s = byPk(pk);
      if (s) s.live = live;
    },
    resume: async () => ({ ptyId: 'pty-resumed' }),
  };
}

export function fakeInbox(
  bus: EventBus,
  items: InboxItem[] = [],
): InboxEngineRuntime & { items: InboxItem[] } {
  const set = (id: string, patch: Partial<InboxItem>): InboxItem => {
    const it = items.find((i) => i.id === id);
    if (!it) throw new Error(`no inbox item ${id}`);
    Object.assign(it, patch, { updatedAt: new Date().toISOString() });
    bus.emit({ type: 'inbox.upserted', item: it });
    return it;
  };
  return {
    items,
    upsert: (u) => {
      const now = new Date().toISOString();
      const it: InboxItem = {
        id: randomUUID(),
        kind: u.kind,
        sessionId: u.sessionId ?? null,
        projectId: u.projectId ?? null,
        ticket: u.ticket ?? null,
        reason: u.reason,
        dedupeKey: inboxDedupeKey(u),
        createdAt: now,
        updatedAt: now,
        state: 'open',
        snoozeUntil: null,
        payload: u.payload ?? {},
      };
      items.push(it);
      bus.emit({ type: 'inbox.upserted', item: it });
      return it;
    },
    resolve: (key) => {
      const dedupeKey = inboxDedupeKey(key);
      const it = items.find(
        (i) => i.dedupeKey === dedupeKey && (i.state === 'open' || i.state === 'snoozed'),
      );
      if (it) set(it.id, { state: 'auto_resolved' });
    },
    list: (f) =>
      items.filter(
        (i) =>
          (!f.state || f.state.includes(i.state)) &&
          (!f.kind || f.kind.includes(i.kind)) &&
          (!f.projectId || i.projectId === f.projectId),
      ),
    markDone: (id) => set(id, { state: 'done' }),
    snooze: (id, until) => set(id, { state: 'snoozed', snoozeUntil: until }),
    reopen: (id) => set(id, { state: 'open', snoozeUntil: null }),
    registerRule: () => {},
    tick: () => {},
    start: () => {},
    stop: () => {},
  };
}

export function fakeNotifier(): Notifier & { channels: NotifyChannelImpl[]; notified: InboxItem[] } {
  const channels: NotifyChannelImpl[] = [];
  const notified: InboxItem[] = [];
  let away = false;
  return {
    channels,
    notified,
    notify: async (i) => {
      notified.push(i);
    },
    register: (c) => {
      channels.push(c);
    },
    setAway: (a) => {
      away = a;
    },
    isAway: () => away,
  };
}

export function p6Context(
  o: { sessions?: Session[]; inbox?: InboxItem[]; config?: Record<string, unknown> } = {},
) {
  const ctx = createTestContext();
  let cfg = OrcConfig.parse(o.config ?? {});
  const audit = ctx.audit;
  if (!audit) throw new Error('P3 createTestContext must set ctx.audit');
  const rawPty = fakePty();
  const inbox = fakeInbox(ctx.bus, o.inbox ?? []);
  const notifier = fakeNotifier();
  ctx.config = () => cfg;
  ctx.updateConfig = (fn) => {
    cfg = OrcConfig.parse(fn(cfg));
    return cfg;
  };
  ctx.pty = withPtyInputAudit(rawPty, audit);
  ctx.sessions = fakeSessions(o.sessions ?? []);
  ctx.inbox = inbox;
  ctx.notifier = notifier;
  ctx.denyList = {
    check: (text: string) =>
      /terraform apply|rm -rf|git push --force/i.test(text)
        ? { denied: true, reason: 'matches the deny-list' }
        : { denied: false, reason: null },
  };
  ctx.plans = undefined; // tests that need P4 plan approval set it explicitly
  return { ctx, rawPty, audit: audit as AuditService, inbox, notifier };
}

/** Test-only middleware: `x-test-remote: <deviceId>` marks the request as coming from a paired remote device. */
export function withRemote(app: OrcApp): OrcApp {
  app.use('*', async (c, next) => {
    const id = c.req.header('x-test-remote');
    c.set('remote', id ? { deviceId: id, deviceName: 'Test phone', login: 'me@example.com' } : null);
    await next();
  });
  return app;
}
