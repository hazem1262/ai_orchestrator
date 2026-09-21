import { describe, expect, it } from 'vitest';
import { ApiRequestError, createApiClient, toQueryString } from './client.ts';

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  };
  return { fn, calls };
}

describe('toQueryString', () => {
  it('drops empty values', () => {
    expect(toQueryString({ a: 'x y', b: undefined, c: null, d: '', e: false, f: 3 })).toBe(
      '?a=x+y&e=false&f=3',
    );
    expect(toQueryString({})).toBe('');
  });
});

describe('createApiClient', () => {
  it('sends the token and parses responses', async () => {
    const { fn, calls } = fakeFetch(200, { items: [], nextCursor: null });
    const api = createApiClient({ baseUrl: 'http://127.0.0.1:4317', token: 'tok', fetch: fn });
    await expect(api.sessionsList({ q: 'hi', touchedProd: true })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(calls[0]?.url).toBe('http://127.0.0.1:4317/api/sessions?q=hi&touchedProd=true');
    expect(new Headers(calls[0]?.init?.headers).get('x-orc-token')).toBe('tok');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('encodes path segments and JSON bodies', async () => {
    const { fn, calls } = fakeFetch(200, { ptyId: 'p1' });
    const api = createApiClient({ baseUrl: '', token: 't', fetch: fn });
    await api.sessionsResume('claude', 'a/b', { mode: 'embedded' });
    expect(calls[0]?.url).toBe('/api/sessions/claude/a%2Fb/resume');
    expect(calls[0]?.init?.body).toBe('{"mode":"embedded"}');
    expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe('application/json');
  });

  it('turns error bodies into ApiRequestError', async () => {
    const { fn } = fakeFetch(409, {
      error: { code: 'session_live', message: 'already running', details: { ptyId: 'p9' } },
    });
    const api = createApiClient({ baseUrl: '', token: 't', fetch: fn });
    const err = await api.sessionsResume('claude', 's', { mode: 'embedded' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 409, code: 'session_live', details: { ptyId: 'p9' } });
  });

  it('reports non-JSON failures with a generic code', async () => {
    const fn: typeof fetch = async () => new Response('oops', { status: 502 });
    const api = createApiClient({ baseUrl: '', token: 't', fetch: fn });
    await expect(api.healthGet()).rejects.toMatchObject({ status: 502, code: 'http_error' });
  });

  it('sends confirm when killing a PTY', async () => {
    const { fn, calls } = fakeFetch(200, { ok: true });
    await createApiClient({ baseUrl: '', token: 't', fetch: fn }).ptyKill('p1');
    expect(calls[0]).toMatchObject({
      url: '/api/pty/p1',
      init: { method: 'DELETE', body: '{"confirm":true}' },
    });
  });

  it('gets a single project config', async () => {
    const { fn, calls } = fakeFetch(200, { id: 'wakecap', name: 'Wakecap', pathPrefixes: ['/w'] });
    const cfg = await createApiClient({ baseUrl: '', token: 't', fetch: fn }).projectsGet('wakecap');
    expect(calls[0]?.url).toBe('/api/projects/wakecap');
    expect(cfg).toMatchObject({ id: 'wakecap', openIn: 'vscode', hidden: false });
  });
});

describe('createApiClient round trips (one per route family)', () => {
  const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 };

  it('health', async () => {
    const body = { ok: true, version: '0.0.0', uptimeS: 12.5 };
    const { fn } = fakeFetch(200, body);
    await expect(createApiClient({ baseUrl: '', token: 't', fetch: fn }).healthGet()).resolves.toEqual(body);
  });

  it('projects list and update', async () => {
    const project = {
      id: 'wakecap',
      name: 'Wakecap',
      pathPrefixes: ['/Users/x/wakecap'],
      hidden: false,
      lastActivityAt: null,
      sessionCount: 3,
    };
    const { fn: listFn } = fakeFetch(200, [project]);
    await expect(createApiClient({ baseUrl: '', token: 't', fetch: listFn }).projectsList()).resolves.toEqual(
      [project],
    );

    const { fn: updateFn, calls } = fakeFetch(200, {
      id: 'wakecap',
      name: 'Wakecap',
      pathPrefixes: ['/Users/x/wakecap'],
      hidden: true,
      openIn: 'vscode',
      ticketRegex: null,
      prodPatterns: [],
      features: { workStreams: false, prodBadges: false, recaps: true },
      repos: [],
      budgets: {},
      maxConcurrentOwned: 6,
    });
    const updated = await createApiClient({ baseUrl: '', token: 't', fetch: updateFn }).projectsUpdate(
      'wakecap',
      {
        hidden: true,
      },
    );
    expect(updated.hidden).toBe(true);
    expect(calls[0]?.url).toBe('/api/projects/wakecap');
  });

  it('sessions get, events, agents, pin, label', async () => {
    const session = {
      id: 's1',
      source: 'claude' as const,
      projectId: 'wakecap',
      startCwd: '/Users/x/wakecap',
      cwds: ['/Users/x/wakecap'],
      name: 'Fix bug',
      firstPrompt: 'fix the bug',
      lastPrompt: 'done?',
      awaySummary: null,
      recap: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T01:00:00.000Z',
      models: ['claude-sonnet-5'],
      permissionMode: 'default',
      usage,
      linesAdded: 10,
      linesRemoved: 2,
      prs: [{ repo: 'wakecap/app', number: 42, url: 'https://github.com/wakecap/app/pull/42' }],
      tickets: ['SAF-1'],
      skills: [],
      mcpServers: [],
      filesTouched: ['src/a.ts'],
      promptCount: 3,
      toolCallCount: 5,
      apiErrorCount: 0,
      flags: { touchedProd: false, hasSubagents: false, automated: false },
      availability: 'resumable' as const,
      transcriptPath: '/Users/x/.claude/history/s1.jsonl',
      lastTest: null,
      live: null,
    };
    const { fn: getFn } = fakeFetch(200, session);
    await expect(
      createApiClient({ baseUrl: '', token: 't', fetch: getFn }).sessionsGet('claude', 's1'),
    ).resolves.toEqual(session);

    const event = {
      sessionId: 's1',
      agentId: null,
      uuid: 'u1',
      parentUuid: null,
      seq: 1,
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'assistant_text' as const,
      turn: 1,
      text: 'hi',
      tool: null,
      toolUseId: null,
      mcpServer: null,
      input: null,
      messageId: 'm1',
      model: 'claude-sonnet-5',
      usage,
      durationMs: 100,
    };
    const { fn: eventsFn } = fakeFetch(200, { items: [event], nextSeq: 2 });
    await expect(
      createApiClient({ baseUrl: '', token: 't', fetch: eventsFn }).sessionsEvents('claude', 's1'),
    ).resolves.toEqual({ items: [event], nextSeq: 2 });

    const agent = {
      id: 'a1',
      sessionId: 's1',
      parentId: null,
      depth: 0,
      agentType: 'general-purpose',
      description: 'do work',
      background: false,
      toolUseId: null,
      usage,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      status: 'running' as const,
      transcriptPath: '/Users/x/.claude/history/a1.jsonl',
    };
    const { fn: agentsFn } = fakeFetch(200, [agent]);
    await expect(
      createApiClient({ baseUrl: '', token: 't', fetch: agentsFn }).sessionsAgents('claude', 's1'),
    ).resolves.toEqual([agent]);

    const { fn: pinFn } = fakeFetch(200, { pinned: true });
    await expect(
      createApiClient({ baseUrl: '', token: 't', fetch: pinFn }).sessionsPin('claude', 's1', true),
    ).resolves.toEqual({ pinned: true });

    const { fn: labelFn } = fakeFetch(200, { labels: ['later'] });
    await expect(
      createApiClient({ baseUrl: '', token: 't', fetch: labelFn }).sessionsLabel('claude', 's1', ['later']),
    ).resolves.toEqual({ labels: ['later'] });
  });

  it('labels list', async () => {
    const { fn } = fakeFetch(200, ['later', 'blocked']);
    await expect(createApiClient({ baseUrl: '', token: 't', fetch: fn }).labelsList()).resolves.toEqual([
      'later',
      'blocked',
    ]);
  });

  it('views list, save, delete', async () => {
    const view = { id: 'v1', name: 'My view', query: { q: 'hi' }, createdAt: '2026-01-01T00:00:00.000Z' };
    const { fn: listFn } = fakeFetch(200, [view]);
    await expect(createApiClient({ baseUrl: '', token: 't', fetch: listFn }).viewsList()).resolves.toEqual([
      view,
    ]);

    const { fn: saveFn } = fakeFetch(200, view);
    await expect(
      createApiClient({ baseUrl: '', token: 't', fetch: saveFn }).viewsSave({
        name: 'My view',
        query: { q: 'hi' },
      }),
    ).resolves.toEqual(view);

    const { fn: deleteFn } = fakeFetch(200, { ok: true });
    await expect(
      createApiClient({ baseUrl: '', token: 't', fetch: deleteFn }).viewsDelete('v1'),
    ).resolves.toEqual({ ok: true });
  });

  it('pty list', async () => {
    const pty = {
      id: 'p1',
      sessionPk: 'claude:s1',
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      cwd: '/Users/x/wakecap',
      pid: 4242,
      startedAt: '2026-01-01T00:00:00.000Z',
      exitedAt: null,
      exitCode: null,
      cols: 120,
      rows: 40,
    };
    const { fn } = fakeFetch(200, [pty]);
    await expect(createApiClient({ baseUrl: '', token: 't', fetch: fn }).ptyList()).resolves.toEqual([pty]);
  });
});
