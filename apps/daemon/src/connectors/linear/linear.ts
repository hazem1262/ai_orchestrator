import type { LinearIssue } from '@orc/api-contract';
import { redact } from '@orc/core';
import type { SecretStore } from '../../services/secrets/secret-store.ts';
import { ConnectorError } from '../errors.ts';
import { createLinearSdkApi, type LinearApi, type LinearViewer } from './api.ts';

export type { LinearIssue };

export interface LinearConnector {
  status(): Promise<'ok' | 'unauthenticated' | 'error'>;
  issue(identifier: string): Promise<LinearIssue | null>;
  comment(identifier: string, markdown: string): Promise<void>;
  createIssue(i: {
    teamKey: string;
    title: string;
    description: string;
    assignToMe?: boolean;
  }): Promise<LinearIssue>;
  assignedToMe(): Promise<LinearIssue[]>;
  me(): Promise<LinearViewer>;
  invalidate(): void;
}

export interface LinearConnectorDeps {
  secrets: SecretStore;
  api?: (token: string) => LinearApi;
  cacheTtlMs?: number;
  now?: () => number;
}

export function toLinearError(e: unknown): ConnectorError {
  if (e instanceof ConnectorError) return e;
  const type = (e as { type?: unknown } | null)?.type;
  const message = e instanceof Error ? e.message : String(e);
  if (type === 'AuthenticationError' || type === 'Forbidden')
    return new ConnectorError('unauthenticated', message);
  if (type === 'InvalidInput' && /not found/i.test(message)) return new ConnectorError('not_found', message);
  if (type === 'InvalidInput' || type === 'UserError') return new ConnectorError('bad_request', message);
  return new ConnectorError('upstream_error', message);
}

export function createLinearConnector(d: LinearConnectorDeps): LinearConnector {
  const factory = d.api ?? createLinearSdkApi;
  const ttl = d.cacheTtlMs ?? 10 * 60_000;
  const now = d.now ?? Date.now;
  let current: { token: string; api: LinearApi } | null = null;
  let viewer: LinearViewer | null = null;
  const issues = new Map<string, { at: number; issue: LinearIssue | null }>();

  function reset(): void {
    current = null;
    viewer = null;
    issues.clear();
  }

  async function run<T>(fn: (api: LinearApi) => Promise<T>): Promise<T> {
    const token = await d.secrets.get('linear.token');
    if (!token) throw new ConnectorError('unauthenticated', 'Linear is not connected');
    let api: LinearApi;
    if (current !== null && current.token === token) {
      api = current.api;
    } else {
      reset();
      api = factory(token);
      current = { token, api };
    }
    try {
      return await fn(api);
    } catch (e) {
      throw toLinearError(e);
    }
  }

  async function me(): Promise<LinearViewer> {
    return run(async (api) => {
      if (viewer) return viewer;
      const v = await api.viewer();
      viewer = v;
      return v;
    });
  }

  async function issue(identifier: string): Promise<LinearIssue | null> {
    const key = identifier.trim().toUpperCase();
    return run(async (api) => {
      const hit = issues.get(key);
      if (hit && now() - hit.at < ttl) return hit.issue;
      const found = await api.issue(key);
      issues.set(key, { at: now(), issue: found });
      return found;
    });
  }

  return {
    async status() {
      try {
        await me();
        return 'ok';
      } catch (e) {
        return e instanceof ConnectorError && e.code === 'unauthenticated' ? 'unauthenticated' : 'error';
      }
    },
    me,
    issue,
    async comment(identifier, markdown) {
      const found = await issue(identifier);
      if (!found) throw new ConnectorError('not_found', `Linear issue ${identifier} not found`);
      await run((api) => api.createComment(found.id, redact(markdown)));
    },
    async createIssue(i) {
      const viewerId = i.assignToMe ? (await me()).id : undefined;
      return run(async (api) => {
        const teamId = await api.teamIdByKey(i.teamKey);
        if (!teamId) throw new ConnectorError('bad_request', `Linear team ${i.teamKey} not found`);
        const created = await api.createIssue({
          teamId,
          title: redact(i.title),
          description: redact(i.description),
          ...(viewerId ? { assigneeId: viewerId } : {}),
        });
        issues.set(created.identifier, { at: now(), issue: created });
        return created;
      });
    },
    assignedToMe: () => run((api) => api.assignedIssues(50)),
    invalidate: reset,
  };
}
