import type { AgncSession } from '@orc/api-contract';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { agncToSession, createAgncCollector } from '../../src/collectors/agnc/agnc-collector.ts';
import { createAgncConnector } from '../../src/connectors/agnc/agnc.ts';
import { normalizeSession, pickArray, toolPayload } from '../../src/connectors/agnc/normalize.ts';
import {
  authGatedAgncFactory,
  FAKE_AGNC_AUTHORIZE_URL,
  fakeAgncFactory,
  makeFakeAgncAuth,
  makeFakeAgncState,
} from '../fakes/agnc-server.ts';
import { fakeProjects, testConfig } from '../fakes/phase7.ts';
import { createTestContext, type TestContext } from '../helpers.ts';

const log = pino({ level: 'silent' });
let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.dispose();
  ctx = null;
});

describe('normalisers', () => {
  it('reads the shapes recorded by spike S4 and tolerates unknown ones', () => {
    expect(toolPayload({ content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(toolPayload({ structuredContent: { b: 2 } })).toEqual({ b: 2 });
    expect(toolPayload({ content: [{ type: 'text', text: 'plain' }] })).toBe('plain');
    expect(pickArray({ sessions: [1, 2] }, ['sessions', 'items'])).toEqual([1, 2]);
    expect(pickArray([3], ['sessions'])).toEqual([3]);
    expect(pickArray(null, ['sessions'])).toEqual([]);
    expect(
      normalizeSession({
        session_id: 'x',
        name: 'T',
        state: 'running',
        repository: { owner: 'o', name: 'r' },
      }),
    ).toEqual({
      id: 'x',
      title: 'T',
      status: 'running',
      repoOwner: 'o',
      repoName: 'r',
      branch: null,
      prUrl: null,
      url: null,
      createdAt: null,
      updatedAt: null,
    });
    expect(normalizeSession({ nope: true })).toBeNull();
  });
});

describe('AgncConnector', () => {
  it('lists my sessions, reads detail and sends prompts', async () => {
    const state = makeFakeAgncState();
    const agnc = createAgncConnector({ factory: fakeAgncFactory(state), log });
    expect(await agnc.status()).toBe('ok');
    const sessions = await agnc.listMySessions();
    expect(sessions.map((s) => [s.id, s.title, s.status])).toEqual([
      ['ag-1', 'SAF-1787 weekend SLA', 'running'],
      ['ag-2', 'Docs sweep', 'completed'],
    ]);
    expect(sessions[0]).toMatchObject({
      repoOwner: 'example-org',
      repoName: 'wecare-service',
      prUrl: 'https://github.com/example-org/wecare-service/pull/9',
    });
    expect((await agnc.getSession('ag-1'))?.branch).toBe('agnc/saf-1787');
    expect((await agnc.listMessages('ag-1')).map((m) => m.text)).toEqual(['fix the SLA']);
    const events = await agnc.listEvents('ag-1');
    expect(events).toEqual({
      items: [{ id: 'e1', type: 'tool_call', messageId: 'm1', text: 'ran tests', createdAt: null }],
      nextCursor: 'cur-2',
    });
    await agnc.sendPrompt('ag-1', 'keep going', 'claude-sonnet-5');
    expect(state.prompts).toEqual([{ sessionId: 'ag-1', prompt: 'keep going', model: 'claude-sonnet-5' }]);
    const created = await agnc.createSession({
      repoOwner: 'example-org',
      repoName: 'wecare-service',
      initialPrompt: 'handoff',
      title: 'Handoff',
    });
    expect(created.id).toBe('ag-3');
    expect(state.created[0]).toMatchObject({ repoOwner: 'example-org', initialPrompt: 'handoff' });
    await agnc.disconnect();
  });

  it('reports errors instead of throwing from status()', async () => {
    const state = makeFakeAgncState();
    state.failNext = 'agnc_list_sessions';
    const agnc = createAgncConnector({ factory: fakeAgncFactory(state), log });
    await expect(agnc.listMySessions()).rejects.toThrow(/upstream/);
    expect(await agnc.status()).toBe('ok');
  });
});

// Spike S4 (`plan/spikes/S4.md`): AGNC answers `initialize` with no token, so a successful
// `client.connect()` does not mean the connector is authorised. The fake below lets
// `initialize` through and rejects every other request with `UnauthorizedError` until
// `transport.finishAuth(code)` runs.
describe('AgncConnector auth when initialize succeeds without a token (spike S4)', () => {
  it('starts OAuth from beginAuth() when connect succeeds but the first tool request is unauthorised', async () => {
    const state = makeFakeAgncState();
    const auth = makeFakeAgncAuth();
    const agnc = createAgncConnector({
      factory: authGatedAgncFactory(state, auth),
      log,
      state: () => 'st-1',
      pendingUrl: () => auth.pendingUrl,
    });
    expect(await agnc.status()).toBe('unauthenticated');
    expect(await agnc.beginAuth()).toEqual({ authorizationUrl: FAKE_AGNC_AUTHORIZE_URL });
    await expect(agnc.finishAuth('code-1', 'wrong-state')).rejects.toThrow(/state/i);
    expect(auth.finishedWith).toEqual([]);
    await agnc.finishAuth('code-1', 'st-1');
    expect(auth.finishedWith).toEqual(['code-1']);
    expect(await agnc.status()).toBe('ok');
    expect((await agnc.listMySessions()).map((s) => s.id)).toEqual(['ag-1', 'ag-2']);
    await agnc.disconnect();
  });

  it('reports "already authorised" from beginAuth() only when an authenticated request succeeds', async () => {
    const auth = makeFakeAgncAuth();
    auth.authorized = true;
    const agnc = createAgncConnector({
      factory: authGatedAgncFactory(makeFakeAgncState(), auth),
      log,
      state: () => 'st-1',
      pendingUrl: () => auth.pendingUrl,
    });
    expect(await agnc.beginAuth()).toEqual({ authorizationUrl: null });
    expect(await agnc.status()).toBe('ok');
    await agnc.disconnect();
  });
});

describe('agnc collector', () => {
  it('maps AGNC sessions into remote sessions and upserts them', async () => {
    const cfg = testConfig({ agnc: { enabled: true } });
    ctx = createTestContext({ config: () => cfg, projects: fakeProjects(cfg) });
    const upserted: Array<{ id: string; status: string | null }> = [];
    const events: string[] = [];
    ctx.bus.on('session.updated', (e) => events.push(e.session.id));
    const agnc = createAgncConnector({ factory: fakeAgncFactory(makeFakeAgncState()), log });
    const collector = createAgncCollector({
      ctx,
      agnc,
      upsert: (s) => upserted.push({ id: s.id, status: s.live?.status ?? null }),
    });
    expect(await collector.tick()).toBe(2);
    expect(upserted).toEqual([
      { id: 'ag-1', status: 'busy' },
      { id: 'ag-2', status: null },
    ]);
    expect(events).toEqual(['ag-1', 'ag-2']);
  });

  it('maps every AGNC status to a live status', () => {
    const base: AgncSession = {
      id: 'x',
      title: null,
      status: 'running',
      repoOwner: null,
      repoName: null,
      branch: null,
      prUrl: null,
      url: null,
      createdAt: null,
      updatedAt: null,
    };
    const statusOf = (status: string) => agncToSession({ ...base, status }, 'wakecap').live?.status ?? null;
    expect(statusOf('running')).toBe('busy');
    expect(statusOf('queued')).toBe('busy');
    expect(statusOf('waiting_for_input')).toBe('waiting');
    expect(statusOf('failed')).toBe('error');
    expect(statusOf('completed')).toBeNull();
    const s = agncToSession(base, 'wakecap');
    expect(s).toMatchObject({ source: 'agnc', availability: 'remote', projectId: 'wakecap' });
    expect(s.live).toMatchObject({ ownership: 'observed', ptyId: null, pid: null });
  });
});
