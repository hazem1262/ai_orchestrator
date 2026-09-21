import type { ApiClient } from '@orc/api-contract';
import { vi } from 'vitest';

const unexpected = (name: string) =>
  vi.fn(async (): Promise<never> => {
    throw new Error(`unexpected api call: ${name}`);
  });

export function createFakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  const base: ApiClient = {
    healthGet: vi.fn(async () => ({ ok: true, version: '0.0.0', uptimeS: 1 })),
    projectsList: vi.fn(async () => []),
    projectsGet: unexpected('projectsGet'),
    projectsUpdate: unexpected('projectsUpdate'),
    sessionsList: vi.fn(async () => ({ items: [], nextCursor: null })),
    sessionsGet: unexpected('sessionsGet'),
    sessionsEvents: vi.fn(async () => ({ items: [], nextSeq: null })),
    sessionsAgents: vi.fn(async () => []),
    sessionsResume: unexpected('sessionsResume'),
    sessionsPin: vi.fn(async (_source: string, _id: string, pinned: boolean) => ({ pinned })),
    sessionsLabel: vi.fn(async (_source: string, _id: string, labels: string[]) => ({ labels })),
    labelsList: vi.fn(async () => []),
    viewsList: vi.fn(async () => []),
    viewsSave: unexpected('viewsSave'),
    viewsDelete: vi.fn(async () => ({ ok: true as const })),
    ptyList: vi.fn(async () => []),
    ptyKill: vi.fn(async () => ({ ok: true as const })),
  };
  return { ...base, ...overrides };
}
