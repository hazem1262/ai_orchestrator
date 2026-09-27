import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AgncClientPair } from '../../src/connectors/agnc/agnc.ts';

export interface FakeAgncState {
  sessions: Array<Record<string, unknown>>;
  messages: Record<string, Array<Record<string, unknown>>>;
  events: Record<string, Array<Record<string, unknown>>>;
  prompts: Array<{ sessionId: string; prompt: string; model?: string }>;
  created: Array<Record<string, unknown>>;
  failNext?: string;
}

export function makeFakeAgncState(): FakeAgncState {
  return {
    sessions: [
      {
        session_id: 'ag-1',
        name: 'SAF-1787 weekend SLA',
        state: 'running',
        repository: { owner: 'example-org', name: 'wecare-service' },
        branch: 'agnc/saf-1787',
        pull_request_url: 'https://github.com/example-org/wecare-service/pull/9',
        created_at: '2026-09-18T08:00:00.000Z',
        updated_at: '2026-09-18T09:00:00.000Z',
      },
      { id: 'ag-2', title: 'Docs sweep', status: 'completed', updatedAt: '2026-09-18T07:00:00.000Z' },
    ],
    messages: {
      'ag-1': [{ id: 'm1', role: 'user', text: 'fix the SLA', created_at: '2026-09-18T08:00:00.000Z' }],
    },
    events: { 'ag-1': [{ id: 'e1', type: 'tool_call', message_id: 'm1', text: 'ran tests' }] },
    prompts: [],
    created: [],
  };
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });

/** One fresh in-memory server+client pair per call, shaped like the real AGNC tools. */
export function fakeAgncFactory(state: FakeAgncState): () => AgncClientPair {
  return () => {
    const server = new McpServer({ name: 'fake-agnc', version: '0.0.0' });
    server.registerTool('agnc_auth_status', { description: 'auth' }, async () =>
      text({ user: 'me', scopes: ['sessions'] }),
    );
    server.registerTool(
      'agnc_list_sessions',
      { description: 'list', inputSchema: { scope: z.string().optional(), limit: z.number().optional() } },
      async ({ scope }) => {
        if (state.failNext === 'agnc_list_sessions') {
          state.failNext = undefined;
          throw new Error('upstream exploded');
        }
        return text({ sessions: scope === 'mine' ? state.sessions : [] });
      },
    );
    server.registerTool(
      'agnc_get_session',
      { description: 'get', inputSchema: { sessionId: z.string() } },
      async ({ sessionId }) => text(state.sessions.find((s) => (s.session_id ?? s.id) === sessionId) ?? null),
    );
    server.registerTool(
      'agnc_list_messages',
      { description: 'messages', inputSchema: { sessionId: z.string(), limit: z.number().optional() } },
      async ({ sessionId }) => text({ messages: state.messages[sessionId] ?? [] }),
    );
    server.registerTool(
      'agnc_list_events',
      {
        description: 'events',
        inputSchema: { sessionId: z.string(), cursor: z.string().optional(), limit: z.number().optional() },
      },
      async ({ sessionId }) => text({ events: state.events[sessionId] ?? [], nextCursor: 'cur-2' }),
    );
    server.registerTool(
      'agnc_send_prompt',
      {
        description: 'prompt',
        inputSchema: { sessionId: z.string(), prompt: z.string(), model: z.string().optional() },
      },
      async (args) => {
        state.prompts.push({ sessionId: args.sessionId, prompt: args.prompt, model: args.model });
        return text({ ok: true });
      },
    );
    server.registerTool(
      'agnc_create_session',
      {
        description: 'create',
        inputSchema: {
          repoOwner: z.string(),
          repoName: z.string(),
          initialPrompt: z.string().optional(),
          title: z.string().optional(),
          baseBranch: z.string().optional(),
          model: z.string().optional(),
        },
      },
      async (args) => {
        const created = {
          id: `ag-${state.created.length + 3}`,
          title: args.title ?? null,
          status: 'queued',
          repository: { owner: args.repoOwner, name: args.repoName },
        };
        state.created.push({ ...args });
        state.sessions.push(created);
        return text(created);
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    void server.connect(serverTransport);
    return { client: new Client({ name: 'orc-test', version: '0.0.0' }), transport: clientTransport };
  };
}

/** Auth state shared by every pair an auth-gated factory hands out. */
export interface FakeAgncAuth {
  authorized: boolean;
  /** The authorisation URL the "provider" captured on the last unauthorised request. */
  pendingUrl: string | null;
  /** Codes passed to `transport.finishAuth`, in order. */
  finishedWith: string[];
}

export const FAKE_AGNC_AUTHORIZE_URL = 'https://agnc.test/mcp/oauth/authorize?state=st-1';

export function makeFakeAgncAuth(): FakeAgncAuth {
  return { authorized: false, pendingUrl: null, finishedWith: [] };
}

/**
 * Behaves like AGNC as observed in spike S4 (`plan/spikes/S4.md`): `initialize` and notifications
 * succeed with no token, and every other request fails with `UnauthorizedError` until
 * `transport.finishAuth(code)` runs. On each unauthorised request it records
 * `FAKE_AGNC_AUTHORIZE_URL` as the pending authorisation URL, the way the SDK's
 * `StreamableHTTPClientTransport` calls `provider.redirectToAuthorization` on a 401.
 */
export function authGatedAgncFactory(state: FakeAgncState, auth: FakeAgncAuth): () => AgncClientPair {
  const inner = fakeAgncFactory(state);
  return () => {
    const pair = inner();
    const transport = pair.transport;
    const send = transport.send.bind(transport);
    const gated = Object.assign(transport, {
      async send(message: JSONRPCMessage, options?: Parameters<typeof send>[1]): Promise<void> {
        const method = 'method' in message ? message.method : null;
        if (
          !auth.authorized &&
          method !== null &&
          method !== 'initialize' &&
          !method.startsWith('notifications/')
        ) {
          auth.pendingUrl = FAKE_AGNC_AUTHORIZE_URL;
          throw new UnauthorizedError();
        }
        return send(message, options);
      },
      async finishAuth(code: string): Promise<void> {
        auth.finishedWith.push(code);
        auth.authorized = true;
        auth.pendingUrl = null;
      },
    });
    return { client: pair.client, transport: gated };
  };
}
