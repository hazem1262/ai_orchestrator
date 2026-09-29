import { createRouter } from '@tanstack/react-router';
import { NotFoundPage } from './routes/-NotFoundPage.tsx';
import { routeTree } from './routeTree.gen.ts';

export function createAppRouter() {
  return createRouter({ routeTree, defaultPreload: 'intent', defaultNotFoundComponent: NotFoundPage });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
