import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { setApiClientForTests } from '../api/client.ts';
import { createFakeApi, type FakeApi } from './fake-api.ts';

/** Renders `ui` inside a QueryClient and a memory router (so <Link> works) with a fake API client.
 *  `RouterContextProvider` puts `ui` in the tree on the first paint — `RouterProvider` renders its
 *  matches only after the router's mount effect, so a synchronous query would find an empty body. */
export function renderWithProviders(ui: ReactNode, opts: { api?: FakeApi; path?: string } = {}) {
  setApiClientForTests(opts.api ?? createFakeApi());
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  const rootRoute = createRootRoute();
  const index = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null });
  const rest = createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, rest]),
    history: createMemoryHistory({ initialEntries: [opts.path ?? '/'] }),
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterContextProvider router={router}>{ui}</RouterContextProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient, router };
}
