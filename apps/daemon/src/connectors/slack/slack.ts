import { redact } from '@orc/core';
import type { SecretStore } from '../../services/secrets/secret-store.ts';
import { ConnectorError } from '../errors.ts';
import { createSlackWebApi, type SlackApi } from './api.ts';
import { compareSlackTs } from './text.ts';

export interface SlackReply {
  ts: string;
  user: string;
  text: string;
  botId: string | null;
  appId: string | null;
}

export interface SlackConnector {
  status(): Promise<'ok' | 'unauthenticated' | 'error'>;
  me(): Promise<{ userId: string; dmChannelId: string; label: string }>;
  post(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>;
  replies(channel: string, threadTs: string, afterTs?: string): Promise<SlackReply[]>;
  mentions(sinceTs: string): Promise<Array<{ channel: string; ts: string; text: string }>>;
  reactions(channel: string, ts: string): Promise<string[]>;
  nudge(text: string): Promise<void>;
  invalidate(): void;
}

export interface SlackConnectorDeps {
  secrets: SecretStore;
  api?: (token: string | null) => SlackApi;
  now?: () => number;
}

const AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
]);
const NOT_FOUND = new Set(['channel_not_found', 'thread_not_found', 'message_not_found']);
const BAD_REQUEST = new Set([
  'missing_scope',
  'not_in_channel',
  'is_archived',
  'invalid_arguments',
  'msg_too_long',
]);

export function toSlackError(e: unknown): ConnectorError {
  if (e instanceof ConnectorError) return e;
  const code = (e as { data?: { error?: unknown } } | null)?.data?.error;
  const message = e instanceof Error ? e.message : String(e);
  if (typeof code === 'string') {
    if (AUTH_ERRORS.has(code)) return new ConnectorError('unauthenticated', `Slack: ${code}`);
    if (NOT_FOUND.has(code)) return new ConnectorError('not_found', `Slack: ${code}`);
    if (BAD_REQUEST.has(code)) return new ConnectorError('bad_request', `Slack: ${code}`);
  }
  return new ConnectorError('upstream_error', message);
}

const byTs = <T extends { ts: string }>(a: T, b: T) => compareSlackTs(a.ts, b.ts);

export function createSlackConnector(d: SlackConnectorDeps): SlackConnector {
  const factory = d.api ?? createSlackWebApi;
  const now = d.now ?? Date.now;
  let current: { token: string; api: SlackApi } | null = null;
  let identity: { userId: string; dmChannelId: string; label: string } | null = null;

  function reset(): void {
    current = null;
    identity = null;
  }

  async function run<T>(fn: (api: SlackApi) => Promise<T>): Promise<T> {
    const token = await d.secrets.get('slack.token');
    if (!token) throw new ConnectorError('unauthenticated', 'Slack is not connected');
    let api: SlackApi;
    if (current !== null && current.token === token) {
      api = current.api;
    } else {
      reset();
      api = factory(token);
      current = { token, api };
    }
    try {
      return await fn(api);
    } catch (e) {
      throw toSlackError(e);
    }
  }

  async function me(): Promise<{ userId: string; dmChannelId: string; label: string }> {
    return run(async (api) => {
      if (identity) return identity;
      const a = await api.authTest();
      const dm = await api.openDm(a.userId);
      const value = { userId: a.userId, dmChannelId: dm, label: `${a.user} @ ${a.team}` };
      identity = value;
      return value;
    });
  }

  return {
    async status() {
      try {
        await me();
        return 'ok';
      } catch (e) {
        return e instanceof ConnectorError && e.code === 'unauthenticated' ? 'unauthenticated' : 'error';
      }
    },
    me,
    async post(channel, text, threadTs) {
      const safe = redact(text).slice(0, 39_000);
      const ts = await run((api) => api.postMessage(channel, safe, threadTs));
      return { ts };
    },
    async replies(channel, threadTs, afterTs) {
      const messages = await run((api) => api.replies(channel, threadTs, afterTs));
      return messages
        .filter((m) => m.ts !== threadTs && (afterTs === undefined || compareSlackTs(m.ts, afterTs) > 0))
        .sort(byTs)
        .map((m) => ({ ts: m.ts, user: m.user ?? '', text: m.text, botId: m.botId, appId: m.appId }));
    },
    async mentions(sinceTs) {
      const who = await me();
      const found = await run((api) => api.searchMessages(`<@${who.userId}>`, 50));
      return found
        .filter((m) => m.channel !== who.dmChannelId && compareSlackTs(m.ts, sinceTs) > 0)
        .sort(byTs);
    },
    async reactions(channel, ts) {
      const who = await me();
      const messages = await run((api) => api.replies(channel, ts));
      const root = messages.find((m) => m.ts === ts);
      return (root?.reactions ?? []).filter((r) => r.users.includes(who.userId)).map((r) => r.name);
    },
    async nudge(text) {
      const safe = redact(text).slice(0, 200);
      await run((api) => api.addReminder(safe, Math.floor(now() / 1000) + 60));
    },
    invalidate: reset,
  };
}
