import type { AgncSession } from '@orc/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgncConnector } from '../../src/connectors/agnc/agnc.ts';
import { createApp } from '../../src/http/app.ts';
import { API_BASE, TEST_TOKEN } from '../../src/http/p7-guard.ts';
import type { HandoffService } from '../../src/services/handoff/handoff.ts';
import { fakeAudit, fakeProjects, fakeSessions, makeSession, testConfig } from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

const remote: AgncSession = {
  id: 'ag-1',
  title: 'SAF-1787',
  status: 'running',
  repoOwner: 'example-org',
  repoName: 'wecare-service',
  branch: 'agnc/saf',
  prUrl: null,
  url: null,
  createdAt: null,
  updatedAt: '2026-09-18T09:00:00.000Z',
};

function setup(o: { withConnector?: boolean } = {}) {
  const cfg = testConfig({ agnc: { enabled: true } });
  const audit = fakeAudit();
  const sessions = fakeSessions([makeSession({ id: 's1', startCwd: '/repo', tickets: ['SAF-1787'] })]);
  const handoffs: HandoffService = {
    generate: async (pk) => ({
      id: 'h1',
      sessionId: pk,
      status: 'in progress',
      summary: 'weekend SLA',
      evidence: [],
      files: ['a.ts'],
      nextSteps: ['add tests'],
      blockers: [],
      links: [],
      createdAt: '2026-09-18T09:00:00.000Z',
    }),
    toMarkdown: (h) => `# Handoff\n${h.summary}`,
    latest: () => null,
    get: () => null,
    resumeFresh: async () => {
      throw new Error('resumeFresh is not used by the AGNC routes');
    },
  };
  const agnc = {
    status: vi.fn(async () => 'ok' as const),
    beginAuth: vi.fn(async () => ({ authorizationUrl: 'https://agnc.wakecap.ai/authorize?state=abc' })),
    finishAuth: vi.fn(async () => {}),
    listMySessions: vi.fn(async () => [remote]),
    getSession: vi.fn(async () => remote),
    listMessages: vi.fn(async () => [
      { id: 'm1', role: 'user', status: null, text: 'fix it', createdAt: null },
    ]),
    listEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
    sendPrompt: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ ...remote, id: 'ag-new' })),
    disconnect: vi.fn(async () => {}),
  } satisfies AgncConnector;
  ctx = createTestContext({ config: () => cfg, projects: fakeProjects(cfg), audit, sessions, handoffs });
  if (o.withConnector !== false) ctx.agnc = agnc;
  const app = createApp({ ctx, token: TEST_TOKEN, port: () => 4317, env: {} });
  const call = (path: string, method = 'GET', body?: unknown) =>
    app.request(`${API_BASE}${path}`, {
      method,
      headers: {
        'x-orc-token': TEST_TOKEN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, agnc, audit };
}

describe('/api/agnc', () => {
  it('reports status and starts the OAuth flow', async () => {
    const t = setup();
    expect(await (await t.call('/api/connectors/agnc/status')).json()).toMatchObject({
      enabled: true,
      status: 'ok',
      url: 'https://agnc.wakecap.ai/mcp',
    });
    expect(await (await t.call('/api/connectors/agnc/connect', 'POST', {})).json()).toEqual({
      authorizationUrl: 'https://agnc.wakecap.ai/authorize?state=abc',
    });
    expect(t.audit.entries.find((e) => e.action === 'agnc.connect')).toBeTruthy();
  });

  it('reads messages and events', async () => {
    const t = setup();
    expect((await (await t.call('/api/agnc/sessions/ag-1/messages')).json()) as unknown[]).toHaveLength(1);
    expect(await (await t.call('/api/agnc/sessions/ag-1/events?cursor=c1')).json()).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(t.agnc.listEvents).toHaveBeenCalledWith('ag-1', 'c1');
  });

  it('needs confirmation to send a prompt and audits it', async () => {
    const t = setup();
    expect((await t.call('/api/agnc/sessions/ag-1/prompt', 'POST', { prompt: 'keep going' })).status).toBe(
      409,
    );
    expect(t.agnc.sendPrompt).not.toHaveBeenCalled();
    const ok = await t.call('/api/agnc/sessions/ag-1/prompt', 'POST', {
      prompt: 'keep going',
      confirm: true,
    });
    expect(ok.status).toBe(200);
    expect(t.agnc.sendPrompt).toHaveBeenCalledWith('ag-1', 'keep going', undefined);
    expect(t.audit.entries.find((e) => e.action === 'agnc.prompt')).toMatchObject({
      actor: 'user',
      target: 'agnc:ag-1',
    });
  });

  it('hands a local session off to AGNC with the handoff markdown', async () => {
    const t = setup();
    const res = await t.call('/api/agnc/handoff', 'POST', {
      source: 'claude',
      id: 's1',
      repoOwner: 'example-org',
      repoName: 'wecare-service',
      confirm: true,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 'ag-new' });
    expect(t.agnc.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwner: 'example-org',
        repoName: 'wecare-service',
        initialPrompt: expect.stringContaining('# Handoff'),
      }),
    );
    expect(t.audit.entries.find((e) => e.action === 'agnc.create')).toBeTruthy();
    expect(
      (await t.call('/api/agnc/handoff', 'POST', { source: 'claude', id: 'missing', confirm: true })).status,
    ).toBe(404);
  });

  it('answers 409 not_enabled without the connector', async () => {
    const t = setup({ withConnector: false });
    expect((await t.call('/api/agnc/sessions/ag-1/messages')).status).toBe(409);
  });
});
