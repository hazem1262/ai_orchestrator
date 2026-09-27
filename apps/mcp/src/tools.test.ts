import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createDaemonClient, type DaemonClient } from './daemon-client.ts';
import { createOrcMcpServer } from './server.ts';
import { resumeCommand } from './tools.ts';

const live = [
  {
    id: 's1',
    source: 'claude',
    projectId: 'wakecap',
    name: 'SAF-1787 weekends',
    startCwd: '/Users/test/Wakecap',
    lastActivityAt: '2026-09-18T09:00:00.000Z',
    usage: { costUsd: 1.5 },
    tickets: ['SAF-1787'],
    prs: [],
    live: {
      status: 'waiting',
      waitingFor: 'input needed',
      ownership: 'owned',
      ptyId: 'pty-1',
      since: '2026-09-18T09:00:00.000Z',
    },
  },
  {
    id: 's2',
    source: 'codex',
    projectId: 'forza',
    name: 'codex thing',
    startCwd: '/Users/test/Forza',
    lastActivityAt: '2026-09-18T08:00:00.000Z',
    usage: { costUsd: 0.2 },
    tickets: [],
    prs: [],
    live: {
      status: 'busy',
      waitingFor: null,
      ownership: 'observed',
      ptyId: null,
      since: '2026-09-18T08:00:00.000Z',
    },
  },
];

function fakeClient(): DaemonClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get<T>(path: string): Promise<T> {
      calls.push(`GET ${path}`);
      if (path === '/api/live') return live as T;
      if (path.startsWith('/api/inbox')) {
        return [
          {
            id: 'i1',
            kind: 'waiting',
            sessionId: 's1',
            projectId: 'wakecap',
            ticket: 'SAF-1787',
            reason: 'waiting for input',
            state: 'open',
            createdAt: '2026-09-18T09:00:00.000Z',
            payload: { source: 'claude', id: 's1' },
          },
          {
            id: 'i2',
            kind: 'automation_result',
            sessionId: null,
            projectId: 'wakecap',
            ticket: null,
            reason: 'Fix CI: success',
            state: 'open',
            createdAt: '2026-09-18T08:00:00.000Z',
            payload: {},
          },
        ] as T;
      }
      if (path.startsWith('/api/sessions?')) {
        return {
          items: [
            {
              pk: 'claude:s1',
              source: 'claude',
              id: 's1',
              name: 'SAF-1787 weekends',
              snippet: 'weekend ⟦SLA⟧',
              lastActivityAt: '2026-09-18T09:00:00.000Z',
              costUsd: 1.5,
              tickets: ['SAF-1787'],
              prs: [],
            },
          ],
          nextCursor: null,
        } as T;
      }
      if (path === '/api/sessions/claude/s1') {
        return {
          ...live[0],
          recap: 'Added the weekend check',
          awaySummary: null,
          filesTouched: ['a.ts'],
          lastTest: { passed: 12, failed: 0, skipped: 0, command: 'pnpm test', ts: 't', durationMs: 900 },
          availability: 'resumable',
        } as T;
      }
      if (path === '/api/streams/SAF-1787')
        return { stream: { ticket: 'SAF-1787', stage: 'in_review', costUsd: 4 } } as T;
      throw new Error(`unexpected GET ${path}`);
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push(`POST ${path} ${JSON.stringify(body)}`);
      return { ptyId: 'pty-9' } as T;
    },
  };
}

async function connect(client: DaemonClient) {
  const server = createOrcMcpServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(clientTransport);
  return mcp;
}

const payload = async (mcp: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  const res = await mcp.callTool({ name, arguments: args });
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content[0]?.text ?? 'null');
};

describe('orc-mcp tools', () => {
  it('exposes the six read tools', async () => {
    const mcp = await connect(fakeClient());
    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'get_session_summary',
      'get_stream',
      'list_live_sessions',
      'list_waiting',
      'resume_session',
      'search_sessions',
    ]);
    await mcp.close();
  });

  it('lists live sessions and filters by project', async () => {
    const mcp = await connect(fakeClient());
    expect(await payload(mcp, 'list_live_sessions')).toEqual([
      {
        pk: 'claude:s1',
        name: 'SAF-1787 weekends',
        status: 'waiting',
        waitingFor: 'input needed',
        projectId: 'wakecap',
        cwd: '/Users/test/Wakecap',
        owned: true,
        costUsd: 1.5,
        since: '2026-09-18T09:00:00.000Z',
      },
      {
        pk: 'codex:s2',
        name: 'codex thing',
        status: 'busy',
        waitingFor: null,
        projectId: 'forza',
        cwd: '/Users/test/Forza',
        owned: false,
        costUsd: 0.2,
        since: '2026-09-18T08:00:00.000Z',
      },
    ]);
    expect(await payload(mcp, 'list_live_sessions', { projectId: 'forza' })).toHaveLength(1);
    await mcp.close();
  });

  it('lists only attention inbox kinds for list_waiting', async () => {
    const mcp = await connect(fakeClient());
    const rows = (await payload(mcp, 'list_waiting')) as Array<{ kind: string }>;
    expect(rows.map((r) => r.kind)).toEqual(['waiting']);
    await mcp.close();
  });

  it('searches sessions and summarises one', async () => {
    const client = fakeClient();
    const mcp = await connect(client);
    const found = (await payload(mcp, 'search_sessions', { query: 'weekend', limit: 5 })) as Array<{
      pk: string;
      snippet: string;
    }>;
    expect(found[0]).toMatchObject({ pk: 'claude:s1', snippet: 'weekend ⟦SLA⟧' });
    expect(client.calls.some((c) => c.includes('q=weekend'))).toBe(true);
    const summary = (await payload(mcp, 'get_session_summary', { source: 'claude', id: 's1' })) as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({
      pk: 'claude:s1',
      recap: 'Added the weekend check',
      status: 'waiting',
      tests: '12 passed, 0 failed',
      resumeCommand: "cd '/Users/test/Wakecap' && claude --resume s1",
    });
    expect(await payload(mcp, 'get_stream', { ticket: 'SAF-1787' })).toMatchObject({
      stream: { stage: 'in_review' },
    });
    await mcp.close();
  });

  it('returns a resume command, and only launches when asked', async () => {
    const client = fakeClient();
    const mcp = await connect(client);
    expect(await payload(mcp, 'resume_session', { source: 'claude', id: 's1' })).toEqual({
      command: "cd '/Users/test/Wakecap' && claude --resume s1",
      cwd: '/Users/test/Wakecap',
      launched: false,
    });
    expect(client.calls.some((c) => c.startsWith('POST'))).toBe(false);
    expect(await payload(mcp, 'resume_session', { source: 'claude', id: 's1', launch: true })).toEqual({
      command: "cd '/Users/test/Wakecap' && claude --resume s1",
      cwd: '/Users/test/Wakecap',
      launched: true,
      ptyId: 'pty-9',
      url: 'http://127.0.0.1:4317/sessions/claude/s1',
    });
    expect(client.calls).toContain('POST /api/sessions/claude/s1/resume {"mode":"embedded"}');
    await mcp.close();
  });

  it('reports daemon errors as tool errors instead of throwing', async () => {
    const broken: DaemonClient = {
      async get() {
        throw Object.assign(new Error('connection refused'), { status: 0, code: 'econnrefused' });
      },
      async post() {
        throw new Error('nope');
      },
    };
    const mcp = await connect(broken);
    const res = await mcp.callTool({ name: 'list_live_sessions', arguments: {} });
    expect((res as { isError?: boolean }).isError).toBe(true);
    await mcp.close();
  });

  it('quotes cwds safely in resume commands', () => {
    expect(resumeCommand({ source: 'codex', id: 'c1', startCwd: "/tmp/it's here" })).toBe(
      "cd '/tmp/it'\\''s here' && codex resume c1",
    );
  });
});

describe('createDaemonClient', () => {
  it('sends the token and turns API errors into DaemonError', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createDaemonClient({
      baseUrl: 'http://127.0.0.1:4317',
      token: 'tok',
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/bad')) {
          return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), {
            status: 404,
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await client.get('/api/health')).toEqual({ ok: true });
    expect((calls[0]?.init?.headers as Record<string, string> | undefined)?.['x-orc-token']).toBe('tok');
    await expect(client.get('/bad')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
