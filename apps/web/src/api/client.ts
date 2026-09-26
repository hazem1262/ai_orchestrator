import {
  type ApiClient,
  createApiClient,
  type P2Methods,
  type P3Methods,
  type Phase4Client,
} from '@orc/api-contract';

declare global {
  interface Window {
    __ORC_TOKEN__?: string;
  }
}

/** The phase-1 routes plus the phase-2, phase-3 and phase-4 ones `createApiClient` merges in. */
export type OrcApiClient = ApiClient & P2Methods & P3Methods & Phase4Client;

let client: OrcApiClient | null = null;

export function getToken(): string {
  return typeof window === 'undefined' ? '' : (window.__ORC_TOKEN__ ?? '');
}

export function getApiClient(): OrcApiClient {
  client ??= createApiClient({ baseUrl: window.location.origin, token: getToken() });
  return client;
}

export function setApiClientForTests(c: OrcApiClient | null): void {
  client = c;
}
