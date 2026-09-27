import { randomBytes } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SecretStore } from '../../services/secrets/secret-store.ts';

export const AGNC_CLIENT_KEY = 'agnc.client';
export const AGNC_TOKENS_KEY = 'agnc.tokens';

export interface KeyringOAuthProvider extends OAuthClientProvider {
  state(): string;
  pendingAuthorizationUrl(): string | null;
  clear(): Promise<void>;
}

/**
 * Keeps the AGNC OAuth client registration and tokens in the SecretStore (the macOS Keychain in
 * production) under `agnc.client` and `agnc.tokens`. Nothing is written to disk, the DB or logs.
 * The PKCE verifier, the `state` and the pending authorisation URL live only in memory.
 */
export function createKeyringOAuthProvider(o: {
  secrets: SecretStore;
  redirectUrl: string;
  clientName?: string;
}): KeyringOAuthProvider {
  let verifier = '';
  let pending: string | null = null;
  let stateValue = randomBytes(16).toString('hex');

  const readJson = async <T>(key: string): Promise<T | undefined> => {
    const raw = await o.secrets.get(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  };

  return {
    get redirectUrl() {
      return o.redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: o.clientName ?? 'Orchestrator',
        redirect_uris: [o.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    state() {
      return stateValue;
    },
    clientInformation: () => readJson<OAuthClientInformationMixed>(AGNC_CLIENT_KEY),
    saveClientInformation: async (client) => o.secrets.set(AGNC_CLIENT_KEY, JSON.stringify(client)),
    tokens: () => readJson<OAuthTokens>(AGNC_TOKENS_KEY),
    saveTokens: async (tokens) => o.secrets.set(AGNC_TOKENS_KEY, JSON.stringify(tokens)),
    redirectToAuthorization: (url) => {
      pending = url.toString();
    },
    saveCodeVerifier: (v) => {
      verifier = v;
    },
    codeVerifier: () => verifier,
    async invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'client') await o.secrets.delete(AGNC_CLIENT_KEY);
      if (scope === 'all' || scope === 'tokens') await o.secrets.delete(AGNC_TOKENS_KEY);
      if (scope === 'all' || scope === 'verifier') verifier = '';
    },
    pendingAuthorizationUrl: () => pending,
    async clear() {
      pending = null;
      verifier = '';
      stateValue = randomBytes(16).toString('hex');
      await o.secrets.delete(AGNC_CLIENT_KEY);
      await o.secrets.delete(AGNC_TOKENS_KEY);
    },
  };
}
