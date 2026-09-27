import type { AgentNode, TimelineEvent, Usage } from '@orc/core';
import { describe, expect, it, vi } from 'vitest';
import { ev, makeP5Context, makeSession, withWakecap } from '../../../test/p5-helpers.ts';
import { createUsageLedger } from './ledger.ts';

const usage = (input: number, output: number): Usage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: null,
});
const agent = (id: string): AgentNode => ({
  id,
  sessionId: 's1',
  parentId: null,
  depth: 1,
  agentType: 'Explore',
  description: 'x',
  background: false,
  toolUseId: null,
  usage: usage(0, 0),
  startedAt: '2026-09-17T10:00:03.000Z',
  endedAt: null,
  status: 'done',
  transcriptPath: '/tmp/a.jsonl',
});

function setup() {
  const s1 = makeSession({
    id: 's1',
    tickets: ['SAF-1'],
    usage: { input: 3500, output: 600, cacheRead: 0, cacheWrite: 0, costUsd: 0.65 },
    lastActivityAt: '2026-09-17T10:05:00.000Z',
  });
  const c1 = makeSession({
    id: 'c1',
    source: 'codex',
    models: ['gpt-5.5-codex'],
    usage: { input: 1200, output: 90, cacheRead: 800, cacheWrite: 0, costUsd: null },
    lastActivityAt: '2026-09-17T11:00:00.000Z',
  });
  const main: TimelineEvent[] = [
    ev({ seq: 1, ts: '2026-09-17T10:00:00.000Z', kind: 'prompt', text: 'go' }),
    ev({
      seq: 2,
      ts: '2026-09-17T10:00:02.000Z',
      kind: 'tool_call',
      messageId: 'm1',
      model: 'claude-opus-5',
      usage: usage(1000, 100),
      tool: 'Bash',
      toolUseId: 't1',
    }),
    ev({ seq: 3, ts: '2026-09-17T10:00:07.000Z', kind: 'tool_result', toolUseId: 't1' }),
    ev({
      seq: 4,
      ts: '2026-09-17T10:00:09.000Z',
      kind: 'assistant_text',
      messageId: 'm2',
      model: 'claude-opus-5',
      usage: usage(2000, 0),
    }),
    ev({
      seq: 5,
      ts: '2026-09-17T10:00:09.500Z',
      kind: 'assistant_text',
      messageId: 'm2',
      model: 'claude-opus-5',
    }),
  ];
  const sub: TimelineEvent[] = [
    ev({
      seq: 1,
      ts: '2026-09-17T10:00:03.000Z',
      kind: 'assistant_text',
      agentId: 'ag1',
      messageId: 'm3',
      model: 'claude-opus-5',
      usage: usage(500, 500),
    }),
  ];
  const data = {
    sessions: [s1, c1],
    events: { 'claude:s1': [...main, ...sub] },
    agents: { 'claude:s1': [agent('ag1')] },
  };
  const t = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data });
  return { ...t, main, data, ledger: createUsageLedger(t.ctx, { debounceMs: 10 }) };
}

const DAY = { from: '2026-09-17T00:00:00.000Z', to: '2026-09-17T23:59:59.999Z' };

describe('usage ledger', () => {
  it('syncs main and subagent usage once, allocating the authoritative session cost', async () => {
    const { ledger } = setup();
    expect(await ledger.syncSession('claude:s1')).toEqual({ added: 3 });
    expect(await ledger.syncSession('claude:s1')).toEqual({ added: 0 });
    const rows = ledger.entries(DAY).filter((r) => r.sessionPk === 'claude:s1');
    expect(rows.map((r) => r.messageId).sort()).toEqual(['m1', 'm2', 'm3']);
    expect(rows.reduce((a, r) => a + r.allocCostUsd, 0)).toBeCloseTo(0.65, 9);
    expect(rows.every((r) => r.authoritative && r.projectId === 'wakecap')).toBe(true);
    expect(rows.find((r) => r.messageId === 'm2')?.latencyMs).toBe(2000);
    expect(ledger.sumCost({ ...DAY, ticket: 'SAF-1' })).toBeCloseTo(0.65, 9);
    expect(ledger.sumCost({ ...DAY, ticket: 'SAF-10' })).toBe(0);
  });

  it('records tool facts with durations', async () => {
    const { ledger } = setup();
    await ledger.syncSession('claude:s1');
    expect(ledger.tools(DAY)).toEqual([
      expect.objectContaining({
        kind: 'tool',
        name: 'Bash',
        toolUseId: 't1',
        durationMs: 5000,
        projectId: 'wakecap',
      }),
    ]);
  });

  it('adds a synthetic row for sessions without per-message usage', async () => {
    const { ledger } = setup();
    await ledger.syncSession('codex:c1');
    expect(ledger.entries(DAY)).toEqual([
      expect.objectContaining({
        sessionPk: 'codex:c1',
        messageId: 'session-total',
        input: 1200,
        output: 90,
        cacheRead: 800,
        source: 'codex',
        model: 'gpt-5.5-codex',
        authoritative: false,
      }),
    ]);
  });

  it('picks up appended events incrementally and exposes the latest main usage', async () => {
    const { ledger, data } = setup();
    await ledger.syncSession('claude:s1');
    data.events['claude:s1'].push(
      ev({
        seq: 6,
        ts: '2026-09-17T10:04:00.000Z',
        kind: 'assistant_text',
        messageId: 'm4',
        model: 'claude-opus-5',
        usage: { input: 5, output: 1, cacheRead: 90_000, cacheWrite: 10, costUsd: null },
      }),
    );
    expect(await ledger.syncSession('claude:s1')).toEqual({ added: 1 });
    expect(ledger.latestMainUsage('claude:s1')).toEqual({
      model: 'claude-opus-5',
      usage: expect.objectContaining({ cacheRead: 90_000 }),
    });
    expect(ledger.latestMainUsage('claude:nope')).toBeNull();
  });

  it('syncs sessions after session.updated when started', async () => {
    const { ctx, ledger, data } = setup();
    ledger.start();
    ctx.bus.emit({ type: 'session.updated', session: data.sessions[0] as (typeof data.sessions)[number] });
    await vi.waitFor(() => expect(ledger.entries(DAY).length).toBeGreaterThanOrEqual(3));
    ledger.stop();
  });
});
