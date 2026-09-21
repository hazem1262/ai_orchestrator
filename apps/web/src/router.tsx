import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen.ts';

export function createAppRouter() {
  return createRouter({ routeTree, defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
