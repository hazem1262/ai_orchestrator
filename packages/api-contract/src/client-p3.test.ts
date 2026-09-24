import { describe, expect, it, vi } from 'vitest';
import { ApiCallError, createP3Methods } from './client-p3.ts';

function fakeFetch(status: number, body: unknown, contentType = 'application/json') {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': contentType },
      }),
  );
}

const stats = {
  session: {
    turns: 0,
    wallMs: 0,
    modelMs: 0,
    toolMs: 0,
    ttftMs: null,
    toolCalls: 0,
    toolErrors: 0,
    apiErrors: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
    tokensPerSec: null,
    cacheHitRate: null,
  },
  turns: [],
  agents: [],
};

describe('createP3Methods', () => {
  it('sends the token and parses the response', async () => {
    const f = fakeFetch(200, stats);
    const m = createP3Methods({ baseUrl: 'http://127.0.0.1:4317', token: 't0k', fetch: f });
    await expect(m.sessionsStats('claude', 's 1')).resolves.toEqual(stats);
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:4317/api/sessions/claude/s%201/stats');
    // biome-ignore lint/correctness/noUnsafeOptionalChaining: init is always set by the fake fetch; a missing init should fail the test
    expect((init?.headers as Record<string, string>)['x-orc-token']).toBe('t0k');
  });

  it('builds query strings and skips empty values', async () => {
    const f = fakeFetch(200, []);
    const m = createP3Methods({ baseUrl: '', token: 't', fetch: f });
    await m.auditList({ sessionPk: 'claude:s-basic', action: undefined, limit: 50 });
    expect(f.mock.calls[0]?.[0]).toBe('/api/audit?sessionPk=claude%3As-basic&limit=50');
  });

  it('posts JSON for deny-check', async () => {
    const f = fakeFetch(200, { denied: true, reason: 'x' });
    const m = createP3Methods({ baseUrl: '', token: 't', fetch: f });
    await expect(m.safetyDenyCheck({ text: 'rm -rf /', projectId: null })).resolves.toEqual({
      denied: true,
      reason: 'x',
    });
    const init = f.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ text: 'rm -rf /', projectId: null }));
  });

  it('requests an unredacted export with confirm', async () => {
    const f = fakeFetch(200, 'PK', 'application/zip');
    const m = createP3Methods({ baseUrl: '', token: 't', fetch: f });
    const blob = await m.sessionsExport('claude', 's-basic', { redact: false });
    expect(blob.size).toBe(2);
    expect(f.mock.calls[0]?.[0]).toBe('/api/sessions/claude/s-basic/export?redact=false&confirm=true');
  });

  it('throws ApiCallError with the server error code', async () => {
    const f = fakeFetch(404, { error: { code: 'not_found', message: 'no such session' } });
    const m = createP3Methods({ baseUrl: '', token: 't', fetch: f });
    const err = await m.sessionsLinks('claude', 'nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'no such session' });
  });
});
