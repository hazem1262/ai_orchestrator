import type { ApiClient, P2Methods, P3Methods } from '@orc/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

/** The full client surface `createApiClient` returns: phase 1 routes plus the phase 2 and phase 3 methods. */
export type P3FakeApi = ApiClient & P2Methods & P3Methods;

export function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } } });
}

export function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }): ReactElement {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

export function renderP3(ui: ReactElement, opts: { client?: QueryClient } = {}) {
  const client = opts.client ?? makeQueryClient();
  return { client, ...render(ui, { wrapper: wrapperFor(client) }) };
}

export function fakeApi(methods: Partial<P3FakeApi>): P3FakeApi {
  return methods as P3FakeApi;
}
