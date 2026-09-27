import {
  type ApiClient,
  createApiClient,
  type P2Methods,
  type P3Methods,
  type P5ClientMethods,
  type P6Methods,
  type Phase4Client,
} from '@orc/api-contract';

declare global {
  interface Window {
    __ORC_TOKEN__?: string;
  }
}

/** The phase-1 routes plus the phase-2, phase-3, phase-4, phase-5 and phase-6 ones `createApiClient` merges in. */
export type OrcApiClient = ApiClient & P2Methods & P3Methods & Phase4Client & P5ClientMethods & P6Methods;

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
