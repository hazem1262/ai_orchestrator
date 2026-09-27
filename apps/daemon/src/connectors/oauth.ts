import { randomBytes } from 'node:crypto';
import type { ConnectorKey } from '../db/repos/connectors.ts';
import { createSlackWebApi, type SlackApi } from './slack/api.ts';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  accountId: string | null;
  scopes: string[];
}

export interface OAuthProvider {
  id: ConnectorKey;
  authorizeUrl(i: { clientId: string; redirectUri: string; state: string }): string;
  exchange(i: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<OAuthTokens>;
  refresh?(i: { clientId: string; clientSecret: string; refreshToken: string }): Promise<OAuthTokens>;
}

export const SLACK_USER_SCOPES: readonly string[] = [
  'chat:write',
  'im:write',
  'im:history',
  'channels:history',
  'groups:history',
  'search:read',
  'users:read',
  'reminders:write',
];

export function slackOAuthProvider(
  api: (token: string | null) => SlackApi = createSlackWebApi,
): OAuthProvider {
  return {
    id: 'slack',
    authorizeUrl({ clientId, redirectUri, state }) {
      const u = new URL('https://slack.com/oauth/v2/authorize');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('user_scope', SLACK_USER_SCOPES.join(','));
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchange(i) {
      const r = await api(null).oauthAccess(i);
      return {
        accessToken: r.userToken,
        refreshToken: null,
        expiresInSec: null,
        accountId: r.userId,
        scopes: r.scopes,
      };
    },
  };
}

export interface OAuthStateStore {
  create(connector: ConnectorKey): string;
  consume(state: string, connector: ConnectorKey): boolean;
}

/** One-time OAuth `state` values: each is accepted once, for the connector that created it, before it expires. */
export function createOAuthStateStore(o: { ttlMs?: number; now?: () => number } = {}): OAuthStateStore {
  const ttl = o.ttlMs ?? 10 * 60_000;
  const now = o.now ?? Date.now;
  const states = new Map<string, { connector: ConnectorKey; exp: number }>();
  return {
    create(connector) {
      for (const [k, v] of states) if (v.exp <= now()) states.delete(k);
      const state = randomBytes(24).toString('base64url');
      states.set(state, { connector, exp: now() + ttl });
      return state;
    },
    consume(state, connector) {
      const v = states.get(state);
      states.delete(state);
      return v !== undefined && v.connector === connector && v.exp > now();
    },
  };
}
