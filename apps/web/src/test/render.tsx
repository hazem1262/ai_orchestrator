import type { ApiClient } from '@orc/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { setApiClientForTests } from '../api/client.ts';
import { createFakeApi } from './fake-api.ts';

/** Renders `ui` inside a QueryClient and a memory router (so <Link> works) with a fake API client. */
export function renderWithProviders(ui: ReactNode, opts: { api?: ApiClient; path?: string } = {}) {
  setApiClientForTests(opts.api ?? createFakeApi());
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  const rootRoute = createRootRoute({ component: () => <>{ui}</> });
  const index = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null });
  const rest = createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, rest]),
    history: createMemoryHistory({ initialEntries: [opts.path ?? '/'] }),
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, queryClient, router };
}
