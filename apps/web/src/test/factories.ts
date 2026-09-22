import type { SessionListItem } from '@orc/api-contract';
import type { InboxItem, LiveState, Session, TimelineEvent } from '@orc/core';

export function sessionFixture(o: Partial<Session> = {}): Session {
  return {
    id: 's1',
    source: 'claude',
    projectId: 'wakecap',
    startCwd: '/Users/test/Wakecap',
    cwds: ['/Users/test/Wakecap'],
    name: 'Notification service test check',
    firstPrompt: 'check the notification service tests',
    lastPrompt: 'continue',
    awaySummary: null,
    recap: null,
    startedAt: '2026-09-01T09:00:00.000Z',
    lastActivityAt: '2026-09-01T09:07:00.000Z',
    models: ['claude-opus-5'],
    permissionMode: 'bypassPermissions',
    usage: { input: 15, output: 27, cacheRead: 2100, cacheWrite: 100, costUsd: 0.42 },
    linesAdded: 1,
    linesRemoved: 1,
    prs: [],
    tickets: [],
    skills: [],
    mcpServers: [],
    filesTouched: [],
    promptCount: 3,
    toolCallCount: 2,
    apiErrorCount: 0,
    flags: { touchedProd: false, hasSubagents: false, automated: false },
    availability: 'resumable',
    transcriptPath: '/t.jsonl',
    lastTest: null,
    live: null,
    ...o,
  };
}

export function eventFixture(o: Partial<TimelineEvent> & { seq: number }): TimelineEvent {
  return {
    sessionId: 's1',
    agentId: null,
    uuid: `u${o.seq}`,
    parentUuid: null,
    ts: '2026-09-01T09:00:00.000Z',
    kind: 'assistant_text',
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
    ...o,
  };
}

export function listItemFixture(o: Partial<SessionListItem> & { id: string }): SessionListItem {
  const source = o.source ?? 'claude';
  return {
    pk: `${source}:${o.id}`,
    source,
    projectId: 'wakecap',
    name: `Session ${o.id}`,
    firstPrompt: 'first prompt',
    lastPrompt: 'last prompt',
    recap: null,
    startedAt: '2026-09-01T09:00:00.000Z',
    lastActivityAt: '2026-09-01T09:07:00.000Z',
    durationMs: 420_000,
    costUsd: 0.42,
    tickets: [],
    prs: [],
    availability: 'resumable',
    pinned: false,
    labels: [],
    live: null,
    snippet: null,
    ...o,
  };
}

export function liveFixture(o: Partial<LiveState> = {}): LiveState {
  return {
    pid: 4242,
    status: 'busy',
    waitingFor: null,
    since: '2026-09-01T09:00:00.000Z',
    ownership: 'observed',
    ptyId: null,
    stage: null,
    currentTool: null,
    backgroundJobs: 0,
    runningSubagents: 0,
    contextFill: null,
    ...o,
  };
}

/** A session that is on the live board: `sessionFixture` with a non-null `live`. */
export function liveSessionFixture(o: Partial<Session> = {}, live: Partial<LiveState> = {}): Session {
  return sessionFixture({ live: liveFixture(live), ...o });
}

export function inboxItemFixture(o: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'i1',
    kind: 'waiting',
    sessionId: 's1',
    projectId: 'wakecap',
    ticket: null,
    reason: 'Session one: waiting — input needed',
    dedupeKey: 'waiting:claude:s1',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    state: 'open',
    snoozeUntil: null,
    payload: { source: 'claude', id: 's1' },
    ...o,
  };
}
