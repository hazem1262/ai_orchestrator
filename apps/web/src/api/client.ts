import { type ApiClient, createApiClient } from '@orc/api-contract';

declare global {
  interface Window {
    __ORC_TOKEN__?: string;
  }
}

let client: ApiClient | null = null;

export function getToken(): string {
  return typeof window === 'undefined' ? '' : (window.__ORC_TOKEN__ ?? '');
}

export function getApiClient(): ApiClient {
  client ??= createApiClient({ baseUrl: window.location.origin, token: getToken() });
  return client;
}

export function setApiClientForTests(c: ApiClient | null): void {
  client = c;
}
