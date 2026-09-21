import type { LiveStatus } from '../types/session.ts';

/**
 * Canonical shape per plan/00-contracts.md §13 (a controller ruling that supersedes the
 * Phase 1 task brief, which only had the P1-era subset). This is the P2 superset: epoch-millis
 * fields stay numbers (the real files store epoch millis, and Phase 2's live-status latency work
 * needs the raw number), and `status` is a closed `RegistryStatus` union that is `null` when
 * absent or unrecognised.
 */
export type RegistryStatus = 'busy' | 'idle' | 'waiting' | 'shell';

export interface RegistryEntry {
  pid: number;
  procStart: string | null;
  sessionId: string;
  cwd: string;
  startedAt: number | null;
  version: string | null;
  kind: string | null;
  name: string | null;
  status: RegistryStatus | null;
  waitingFor: string | null;
  statusUpdatedAt: number | null;
  updatedAt: number | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const REGISTRY_STATUSES = new Set<RegistryStatus>(['busy', 'idle', 'waiting', 'shell']);
function toStatus(v: unknown): RegistryStatus | null {
  return typeof v === 'string' && REGISTRY_STATUSES.has(v as RegistryStatus) ? (v as RegistryStatus) : null;
}

/**
 * ~/.claude/sessions/<pid>.json. Per spike S3, the registry is written non-atomically, so a
 * read can land on truncated JSON, a partial object, or ENOENT. This parser never throws: any
 * malformed input (non-object, or missing/wrong-typed `pid`/`sessionId`/`cwd`) simply yields
 * `null` for the caller to skip and wait for the next file-watch event.
 *
 * Only whitelisted fields are copied onto the result. `messagingSocketPath` (Claude's internal
 * IPC socket) and any `peer*` fields are never read, let alone copied.
 */
export function parseRegistryEntry(value: unknown): RegistryEntry | null {
  if (!isObj(value)) return null;
  const { pid, sessionId, cwd } = value;
  if (typeof pid !== 'number' || typeof sessionId !== 'string' || typeof cwd !== 'string') return null;
  return {
    pid,
    procStart: str(value.procStart),
    sessionId,
    cwd,
    startedAt: numOrNull(value.startedAt),
    version: str(value.version),
    kind: str(value.kind),
    name: str(value.name),
    status: toStatus(value.status),
    waitingFor: str(value.waitingFor),
    statusUpdatedAt: numOrNull(value.statusUpdatedAt),
    updatedAt: numOrNull(value.updatedAt),
  };
}

/** Alias for later tasks (indexer, session service) that import the brief's original name. */
export const parseRegistryFile = parseRegistryEntry;

const REGISTRY_FILE_NAME = /^\d+\.json$/;

/** True only for `<pid>.json`; rejects the `<pid>.<hex>.key` lock files Claude also writes there. */
export function isRegistryFileName(name: string): boolean {
  return REGISTRY_FILE_NAME.test(name);
}

export function registryStatusToLive(status: string): LiveStatus {
  switch (status) {
    case 'busy':
    case 'idle':
    case 'waiting':
    case 'shell':
      return status;
    default:
      return 'idle';
  }
}
