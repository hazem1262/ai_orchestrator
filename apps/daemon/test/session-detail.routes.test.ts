import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apportionCost } from '../src/services/session-detail/detail.ts';
import { createP3Harness, type P3Harness } from './p3-harness.ts';

let t: P3Harness;
beforeAll(async () => {
  t = await createP3Harness();
});
afterAll(async () => {
  await t.cleanup();
});

async function get<T>(path: string, status = 200): Promise<T> {
  const res = await t.request(path);
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

type Stats = {
  session: {
    toolCalls: number;
    toolMs: number;
    cacheHitRate: number | null;
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
  turns: Array<{ turn: number; toolMs: number; ttftMs: number | null; reportedMs: number | null }>;
  agents: Array<{ agentId: string }>;
};

describe('GET /api/sessions/:source/:id/stats', () => {
  it('computes s-basic timing and token stats', async () => {
    const s = await get<Stats>('/api/sessions/claude/s-basic/stats');
    expect(s.turns.map((x) => x.turn)).toEqual([1, 2, 3]);
    expect(s.turns[0]).toMatchObject({ toolMs: 25000, ttftMs: 5000, reportedMs: 36000 });
    expect(s.session.toolCalls).toBe(2);
    expect(s.session.usage).toMatchObject({ input: 15, output: 27, cacheRead: 2100, cacheWrite: 100 });
    expect(s.session.cacheHitRate).toBeCloseTo(2100 / 2215, 6);
  });

  it('includes one entry per subagent', async () => {
    const s = await get<Stats>('/api/sessions/claude/s-subagents/stats');
    expect(s.agents.map((a) => a.agentId).sort()).toEqual(['ag1', 'ag2', 'ag3']);
  });

  it('404s for unknown sessions and sources', async () => {
    await get('/api/sessions/claude/nope/stats', 404);
    await get('/api/sessions/foo/s-basic/stats', 404);
  });
});

describe('deliverables, files, usage series', () => {
  it('lists the Edit in turn 1 as a deliverable', async () => {
    const d = await get<
      Array<{
        turn: number;
        agentId: string | null;
        files: Array<{ path: string; status: string; tools: string[] }>;
      }>
    >('/api/sessions/claude/s-basic/deliverables');
    expect(d).toEqual([
      {
        turn: 1,
        agentId: null,
        files: [
          {
            path: '/Users/test/Wakecap/Backend/svc/a.ts',
            tools: ['Edit'],
            ops: 1,
            status: 'pending',
            lastTs: '2026-09-01T09:00:35.000Z',
          },
        ],
      },
    ]);
  });

  it('summarizes files with edit snippets', async () => {
    const f = await get<
      Array<{ path: string; changes: Array<{ oldText: string | null; newText: string | null }> }>
    >('/api/sessions/claude/s-basic/files');
    expect(f[0]?.path).toBe('/Users/test/Wakecap/Backend/svc/a.ts');
    expect(f[0]?.changes[0]).toMatchObject({ oldText: 'a', newText: 'b' });
  });

  it('returns one usage point per deduplicated message with apportioned cost', async () => {
    const u = await get<Array<{ model: string; output: number; costUsd: number | null }>>(
      '/api/sessions/claude/s-basic/usage-series',
    );
    expect(u.map((p) => [p.model, p.output])).toEqual([
      ['claude-opus-5', 20],
      ['claude-opus-5', 7],
    ]);
    // weights: 10 + 5·20 + 1.25·100 + 0.1·1000 = 335 ; 5 + 5·7 + 0 + 0.1·1100 = 150 ; cost-state total 0.42
    expect(u[0]?.costUsd).toBeCloseTo((0.42 * 335) / 485, 9);
    expect(u[1]?.costUsd).toBeCloseTo((0.42 * 150) / 485, 9);
  });

  it('apportionCost leaves costs null without a total', () => {
    const p = {
      ts: 't',
      agentId: null,
      model: 'm',
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: null,
    };
    expect(apportionCost([p], null)).toEqual([p]);
    expect(apportionCost([{ ...p, input: 0, output: 0 }], 1)[0]?.costUsd).toBe(0);
  });
});

describe('GET /api/sessions/:source/:id/safety', () => {
  it('flags prod touches without leaking secrets', async () => {
    const res = await t.request('/api/sessions/claude/s-drift/safety');
    const text = await res.text();
    expect(text).not.toContain('hunter2');
    const s = JSON.parse(text) as {
      touchedProd: boolean;
      prodTouches: Array<{ kind: string }>;
      permissionBadge: string;
    };
    expect(s.touchedProd).toBe(true);
    expect(s.prodTouches.map((p) => p.kind).sort()).toEqual(['command', 'skill']);
    expect(s.permissionBadge).toBe('unknown');
  });

  it('maps bypassPermissions to the bypass badge', async () => {
    const s = await get<{ permissionBadge: string }>('/api/sessions/claude/s-basic/safety');
    expect(s.permissionBadge).toBe('bypass');
  });
});

describe('GET /api/sessions/:source/:id/raw', () => {
  type Page = { items: Array<{ offset: number; text: string; partial: boolean }>; nextOffset: number | null };

  it('pages through the transcript', async () => {
    const first = await get<Page>('/api/sessions/claude/s-basic/raw?limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextOffset).not.toBeNull();
    const second = await get<Page>(`/api/sessions/claude/s-basic/raw?limit=2&offset=${first.nextOffset}`);
    expect(second.items[0]?.offset).toBe(first.nextOffset);
  });

  it('shows the truncated last line of s-errors as partial', async () => {
    const page = await get<Page>('/api/sessions/claude/s-errors/raw');
    expect(page.items).toHaveLength(3);
    expect(page.items[2]?.partial).toBe(true);
    expect(page.nextOffset).toBeNull();
  });

  it('redacts and supports subagent transcripts', async () => {
    const drift = await get<Page>('/api/sessions/claude/s-drift/raw');
    expect(JSON.stringify(drift)).not.toContain('hunter2');
    const agent = await get<Page>('/api/sessions/claude/s-subagents/raw?agentId=ag1');
    expect(agent.items).toHaveLength(2);
    await get('/api/sessions/claude/s-subagents/raw?agentId=nope', 404);
    await get('/api/sessions/claude/s-basic/raw?limit=0', 400);
  });
});
