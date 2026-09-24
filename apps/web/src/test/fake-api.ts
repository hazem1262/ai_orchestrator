import type { ApiClient, P2Methods, P3Methods } from '@orc/api-contract';
import { vi } from 'vitest';

const unexpected = (name: string) =>
  vi.fn(async (): Promise<never> => {
    throw new Error(`unexpected api call: ${name}`);
  });

export type FakeApi = ApiClient & P2Methods & P3Methods;

export function createFakeApi(overrides: Partial<FakeApi> = {}): FakeApi {
  const base: FakeApi = {
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
    liveList: vi.fn(async () => []),
    sessionsLaunch: unexpected('sessionsLaunch'),
    sessionsKill: unexpected('sessionsKill'),
    sessionsOpenIn: unexpected('sessionsOpenIn'),
    inboxList: vi.fn(async () => []),
    inboxDone: unexpected('inboxDone'),
    inboxSnooze: unexpected('inboxSnooze'),
    inboxReopen: unexpected('inboxReopen'),
    templatesList: vi.fn(async () => []),
    archiveStatus: unexpected('archiveStatus'),
    archiveRestore: unexpected('archiveRestore'),
    archiveSync: unexpected('archiveSync'),
    notificationsGet: unexpected('notificationsGet'),
    notificationsPut: unexpected('notificationsPut'),
    sessionsStats: unexpected('sessionsStats'),
    sessionsDeliverables: unexpected('sessionsDeliverables'),
    sessionsFiles: unexpected('sessionsFiles'),
    sessionsUsageSeries: unexpected('sessionsUsageSeries'),
    sessionsSafety: unexpected('sessionsSafety'),
    sessionsLinks: unexpected('sessionsLinks'),
    sessionsRaw: unexpected('sessionsRaw'),
    sessionsExport: unexpected('sessionsExport'),
    plansList: unexpected('plansList'),
    plansContent: unexpected('plansContent'),
    auditList: unexpected('auditList'),
    safetySecrets: unexpected('safetySecrets'),
    safetyDenyCheck: unexpected('safetyDenyCheck'),
  };
  return { ...base, ...overrides };
}
