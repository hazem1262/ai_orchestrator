import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AgncEvent, AgncEventPage, AgncMessage, AgncSession } from '@orc/api-contract';
import { redact } from '@orc/core';
import type { Logger } from 'pino';
import { ServiceError } from '../../services/errors.ts';
import { normalizeEvent, normalizeMessage, normalizeSession, pickArray, toolPayload } from './normalize.ts';

export interface AgncConnector {
  status(): Promise<'ok' | 'unauthenticated' | 'error'>;
  beginAuth(): Promise<{ authorizationUrl: string | null }>;
  finishAuth(code: string, state: string): Promise<void>;
  listMySessions(): Promise<AgncSession[]>;
  getSession(id: string): Promise<AgncSession | null>;
  listMessages(id: string): Promise<AgncMessage[]>;
  listEvents(id: string, cursor?: string): Promise<{ items: AgncEvent[]; nextCursor: string | null }>;
  sendPrompt(id: string, prompt: string, model?: string): Promise<void>;
  createSession(i: {
    repoOwner: string;
    repoName: string;
    baseBranch?: string;
    title?: string;
    initialPrompt: string;
    model?: string;
  }): Promise<AgncSession>;
  disconnect(): Promise<void>;
  /** Forgets the client registration and tokens, so the next connect starts a fresh OAuth flow. */
  signOut?(): Promise<void>;
}

export interface AgncClientPair {
  client: Client;
  transport: Transport & { finishAuth?(code: string): Promise<void> };
}
export type AgncClientFactory = () => AgncClientPair;

export function createStreamableFactory(o: {
  url: string;
  provider: OAuthClientProvider;
}): AgncClientFactory {
  return () => ({
    client: new Client({ name: 'orchestrator', version: '0.7.0' }),
    transport: new StreamableHTTPClientTransport(new URL(o.url), { authProvider: o.provider }),
  });
}

const closeQuietly = async (pair: AgncClientPair | null): Promise<void> => {
  await pair?.client.close().catch(() => {});
};

export function createAgncConnector(deps: {
  factory: AgncClientFactory;
  log: Logger;
  /** OAuth state to check on the callback (from the keyring provider). */
  state?: () => string;
  /** The authorisation URL the provider captured during the failed request. */
  pendingUrl?: () => string | null;
  /** Deletes the stored client registration and tokens (the keyring provider's `clear`). */
  clear?: () => Promise<void>;
}): AgncConnector {
  let live: AgncClientPair | null = null;
  let pendingAuth: AgncClientPair | null = null;
  let connecting: Promise<Client> | null = null;

  const setPending = (pair: AgncClientPair) => {
    if (pendingAuth && pendingAuth !== pair) void closeQuietly(pendingAuth);
    pendingAuth = pair;
  };

  /**
   * Spike S4: AGNC answers `initialize` without a token, so a successful `connect()` does not mean
   * the client is authorised. One authenticated request (`tools/list`) runs inside the same `try`
   * before the pair is marked live; a 401 there leaves the pair pending so `finishAuth` can finish it.
   */
  async function open(): Promise<Client> {
    const pair = deps.factory();
    try {
      await pair.client.connect(pair.transport);
      await pair.client.listTools();
    } catch (e) {
      if (e instanceof UnauthorizedError) setPending(pair);
      else await closeQuietly(pair);
      throw e;
    }
    live = pair;
    if (pendingAuth && pendingAuth !== pair) await closeQuietly(pendingAuth);
    pendingAuth = null;
    return pair.client;
  }

  /**
   * While an OAuth flow is pending, only `beginAuth` opens a new pair: each 401 makes the SDK
   * regenerate the PKCE verifier, which would break the authorisation URL the user already has.
   */
  async function getClient(o: { restartAuth?: boolean } = {}): Promise<Client> {
    if (live) return live.client;
    if (pendingAuth && !o.restartAuth) throw new UnauthorizedError('AGNC authorisation pending');
    connecting ??= open().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  async function closeAll(): Promise<void> {
    const pairs = [live, pendingAuth];
    live = null;
    pendingAuth = null;
    for (const p of pairs) await closeQuietly(p);
  }

  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await getClient();
    let result: Awaited<ReturnType<Client['callTool']>>;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch (e) {
      // The token can be revoked or expire past refresh after the pair went live.
      if (e instanceof UnauthorizedError && live?.client === client) {
        setPending(live);
        live = null;
      }
      throw e;
    }
    if ((result as { isError?: boolean }).isError) {
      const detail = redact(JSON.stringify(toolPayload(result)) ?? '').slice(0, 200);
      throw new ServiceError('upstream_error', 502, `${name} failed: ${detail}`);
    }
    return toolPayload(result);
  }

  return {
    async status() {
      try {
        await call('agnc_auth_status', {});
        return 'ok';
      } catch (e) {
        if (e instanceof UnauthorizedError) return 'unauthenticated';
        deps.log.warn({ err: e }, 'agnc status failed');
        return 'error';
      }
    },

    async beginAuth() {
      const url = pendingAuth ? (deps.pendingUrl?.() ?? null) : null;
      if (url) return { authorizationUrl: url };
      try {
        await getClient({ restartAuth: true });
        return { authorizationUrl: null }; // an authenticated request succeeded: already authorised
      } catch (e) {
        if (e instanceof UnauthorizedError) return { authorizationUrl: deps.pendingUrl?.() ?? null };
        throw e;
      }
    },

    async finishAuth(code, state) {
      if (deps.state && deps.state() !== state)
        throw new ServiceError('invalid_state', 400, 'OAuth state mismatch');
      const pair = pendingAuth;
      if (!pair?.transport.finishAuth)
        throw new ServiceError('invalid_state', 409, 'no OAuth flow in progress');
      await pair.transport.finishAuth(code);
      pendingAuth = null;
      await closeQuietly(pair);
      await closeQuietly(live);
      live = null;
      await getClient();
    },

    async listMySessions() {
      const payload = await call('agnc_list_sessions', { scope: 'mine', limit: 50 });
      return pickArray(payload, ['sessions', 'items', 'data'])
        .map(normalizeSession)
        .filter((s): s is AgncSession => s !== null);
    },

    async getSession(id) {
      return normalizeSession(await call('agnc_get_session', { sessionId: id }));
    },

    async listMessages(id) {
      const payload = await call('agnc_list_messages', { sessionId: id, limit: 100 });
      return pickArray(payload, ['messages', 'items', 'data'])
        .map(normalizeMessage)
        .filter((m): m is AgncMessage => m !== null);
    },

    async listEvents(id, cursor): Promise<AgncEventPage> {
      const payload = await call('agnc_list_events', {
        sessionId: id,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const items = pickArray(payload, ['events', 'items', 'data'])
        .map(normalizeEvent)
        .filter((e): e is AgncEvent => e !== null);
      const next =
        typeof payload === 'object' && payload !== null && 'nextCursor' in payload
          ? ((payload as { nextCursor?: unknown }).nextCursor ?? null)
          : null;
      return { items, nextCursor: typeof next === 'string' ? next : null };
    },

    async sendPrompt(id, prompt, model) {
      await call('agnc_send_prompt', { sessionId: id, prompt, ...(model ? { model } : {}) });
    },

    async createSession(i) {
      const created = normalizeSession(await call('agnc_create_session', { ...i }));
      if (!created) throw new ServiceError('upstream_error', 502, 'agnc_create_session returned no session');
      return created;
    },

    disconnect: closeAll,

    async signOut() {
      await closeAll();
      await deps.clear?.();
    },
  };
}
