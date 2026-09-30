import type {
  CheckpointRecord,
  DiffResult,
  PrRef,
  PrStatus,
  ReviewComment,
  ReviewSummary,
  Source,
  WorktreeView,
} from '@orc/core';
import type { z } from 'zod';
import { ApiRequestError, toQueryString } from './client.ts';
import type { ShipSuggestion } from './routes/ship.ts';
import type {
  CreateWorktreeBody,
  CreateWorktreeResult,
  SyncPreview,
  WorktreeCleanupPreview,
  WorktreeCleanupQuery,
  WorktreeCleanupResult,
  WorktreeListQuery,
} from './routes/worktrees.ts';

export interface ApiRequestOptions<T> {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  schema?: z.ZodType<T>;
}

export type ApiRequester = <T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts?: ApiRequestOptions<T>,
) => Promise<T>;

/**
 * The fetch-backed `ApiRequester` `createApiClient` composes the phase 4 factories with. Errors are
 * P1's `ApiRequestError` (contracts §13): there is no separate phase 4 error class.
 */
export function makeRequester(o: { baseUrl: string; token: string; fetch?: typeof fetch }): ApiRequester {
  const doFetch = o.fetch ?? fetch;
  return async <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts: ApiRequestOptions<T> = {},
  ): Promise<T> => {
    const headers: Record<string, string> = { 'x-orc-token': o.token };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await doFetch(`${o.baseUrl}${path}${toQueryString(opts.query ?? {})}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new ApiRequestError(
        res.status,
        e?.code ?? 'http_error',
        e?.message ?? `HTTP ${res.status}`,
        e?.details,
      );
    }
    return opts.schema ? opts.schema.parse(json) : (json as T);
  };
}

type In<T extends z.ZodType> = z.input<T>;
const enc = encodeURIComponent;

export function worktreesClient(req: ApiRequester) {
  return {
    worktreesList: (q: z.infer<typeof WorktreeListQuery> = {}) =>
      req<WorktreeView[]>('GET', '/api/worktrees', { query: q }),
    worktreesDiscover: () => req<WorktreeView[]>('POST', '/api/worktrees/discover', { body: {} }),
    worktreesGet: (path: string) => req<WorktreeView>('GET', '/api/worktrees/one', { query: { path } }),
    worktreesCreate: (body: In<typeof CreateWorktreeBody>) =>
      req<z.infer<typeof CreateWorktreeResult>>('POST', '/api/worktrees', { body }),
    worktreesScript: (body: { path: string; which: 'setup' | 'run' | 'archive'; confirm: boolean }) =>
      req<{ ptyId: string }>('POST', '/api/worktrees/script', { body }),
    worktreesOpen: (body: { path: string; target: 'vscode' | 'terminal' | 'finder' }) =>
      req<{ ok: true }>('POST', '/api/worktrees/open', { body }),
    worktreesSyncPreview: (path: string) =>
      req<z.infer<typeof SyncPreview>>('GET', '/api/worktrees/sync-preview', { query: { path } }),
    worktreesSync: (body: { path: string; confirm: boolean }) =>
      req<{ files: number }>('POST', '/api/worktrees/sync', { body }),
    worktreesArchive: (body: { path: string; confirm: boolean; confirmExternal: boolean }) =>
      req<{ ok: true }>('POST', '/api/worktrees/archive', { body }),
    worktreesCleanupPreview: (q: z.infer<typeof WorktreeCleanupQuery> = {}) =>
      req<z.infer<typeof WorktreeCleanupPreview>>('GET', '/api/worktrees/cleanup/preview', { query: q }),
    worktreesCleanup: (body: { paths: string[]; confirm: boolean }) =>
      req<z.infer<typeof WorktreeCleanupResult>>('POST', '/api/worktrees/cleanup', { body }),
  };
}

export function reviewClient(req: ApiRequester) {
  return {
    diffGet: (q: { cwd: string; from?: string; to?: string }) =>
      req<DiffResult>('GET', '/api/diff', { query: q }),
    diffRevert: (body: { cwd: string; file: string; hunkIndex?: number; from?: string; confirm: boolean }) =>
      req<{ reverted: string }>('POST', '/api/diff/revert', { body }),
    checkpointsList: (sessionPk: string) =>
      req<CheckpointRecord[]>('GET', '/api/checkpoints', { query: { sessionPk } }),
    checkpointsDiff: (id: string) => req<DiffResult>('GET', `/api/checkpoints/${enc(id)}/diff`),
    checkpointsCreate: (body: { sessionPk: string; confirm: boolean }) =>
      req<CheckpointRecord>('POST', '/api/checkpoints', { body }),
    checkpointsRewind: (id: string, body: { confirm: boolean }) =>
      req<{ safety: CheckpointRecord }>('POST', `/api/checkpoints/${enc(id)}/rewind`, { body }),
    reviewGet: (source: Source, id: string) => req<ReviewSummary>('GET', `/api/review/${source}/${enc(id)}`),
    reviewComments: (
      source: Source,
      id: string,
      body: { comments: ReviewComment[]; deliver: 'session' | 'text'; confirm: boolean },
    ) => req<{ sent: boolean; text: string }>('POST', `/api/review/${source}/${enc(id)}/comments`, { body }),
  };
}

export function shipClient(req: ApiRequester) {
  return {
    shipSuggest: (q: { cwd: string; sessionPk?: string }) =>
      req<z.infer<typeof ShipSuggestion>>('GET', '/api/ship/suggest', { query: q }),
    shipCommit: (body: { cwd: string; message: string; confirm: boolean }) =>
      req<{ sha: string }>('POST', '/api/ship/commit', { body }),
    shipPush: (body: { cwd: string; confirm: boolean }) =>
      req<{ ok: true }>('POST', '/api/ship/push', { body }),
    shipPr: (body: {
      cwd: string;
      title: string;
      body: string;
      base: string;
      draft: boolean;
      confirm: boolean;
    }) => req<PrRef>('POST', '/api/ship/pr', { body }),
    shipMerge: (body: { pr: PrRef; method: 'merge' | 'squash' | 'rebase'; confirm: boolean }) =>
      req<{ ok: true }>('POST', '/api/ship/merge', { body }),
    shipBackmerge: (body: { cwd: string; projectId: string; ticket: string | null; confirm: boolean }) =>
      req<{ ptyId: string }>('POST', '/api/ship/backmerge', { body }),
    planApprove: (source: Source, id: string, body: { confirm: boolean }) =>
      req<{ ok: true }>('POST', `/api/sessions/${source}/${enc(id)}/plan/approve`, { body }),
    planReject: (source: Source, id: string, body: { feedback: string; confirm: boolean }) =>
      req<{ ok: true }>('POST', `/api/sessions/${source}/${enc(id)}/plan/reject`, { body }),
  };
}

export function githubClient(req: ApiRequester) {
  return {
    githubStatus: () =>
      req<{ status: 'ok' | 'unauthenticated' | 'error' | 'disabled' }>('GET', '/api/github/status'),
    githubPr: (repo: string, number: number) =>
      req<PrStatus>('GET', '/api/github/pr', { query: { repo, number } }),
    githubMine: () => req<PrStatus[]>('GET', '/api/github/prs/mine'),
  };
}

export type Phase4Client = ReturnType<typeof worktreesClient> &
  ReturnType<typeof reviewClient> &
  ReturnType<typeof shipClient> &
  ReturnType<typeof githubClient>;

export function createPhase4Methods(o: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}): Phase4Client {
  const req = makeRequester(o);
  return { ...worktreesClient(req), ...reviewClient(req), ...shipClient(req), ...githubClient(req) };
}
