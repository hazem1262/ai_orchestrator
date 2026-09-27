import {
  type ApiClient,
  createApiClient,
  type P2Methods,
  type P3Methods,
  type P5ClientMethods,
  type P6Methods,
  type Phase4Client,
} from '@orc/api-contract';
import { resolveToken } from './token.ts';

/** The phase-1 routes plus the phase-2, phase-3, phase-4, phase-5 and phase-6 ones `createApiClient` merges in. */
export type OrcApiClient = ApiClient & P2Methods & P3Methods & Phase4Client & P5ClientMethods & P6Methods;

let client: OrcApiClient | null = null;

/** The injected install token on the Mac, or the paired device token on a remote device. */
export function getToken(): string {
  return resolveToken();
}

export function getApiClient(): OrcApiClient {
  client ??= createApiClient({ baseUrl: window.location.origin, token: getToken() });
  return client;
}

/** Rebuilds the client on next use, after the device token changes. */
export function resetApiClient(): void {
  client = null;
}

export function setApiClientForTests(c: OrcApiClient | null): void {
  client = c;
}
