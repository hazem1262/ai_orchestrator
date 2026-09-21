import type { AgentNode, Project, Session, Source } from '@orc/core';
import { z } from 'zod';
import { makeCaller, type P2Methods, p2Methods } from './client-p2.ts';
import { ProjectConfig } from './config.ts';
import { AgentNodeSchema, ProjectSchema, SessionSchema } from './domain.ts';
import { ApiError } from './errors.ts';
import { type HealthResponse, HealthResponseSchema } from './routes/health.ts';
import type { ProjectPatch } from './routes/projects.ts';
import { type PtyInfo, PtyInfoSchema } from './routes/pty.ts';
import {
  LabelResponseSchema,
  LabelsListSchema,
  OkSchema,
  PinResponseSchema,
  type ResumeRequest,
  type ResumeResponse,
  ResumeResponseSchema,
  type SessionEventsResponse,
  SessionEventsResponseSchema,
  type SessionListFilters,
  type SessionListResponse,
  SessionListResponseSchema,
} from './routes/sessions.ts';
import { type SavedView, SavedViewSchema } from './routes/views.ts';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface ApiClient {
  healthGet(): Promise<HealthResponse>;
  projectsList(): Promise<Project[]>;
  projectsGet(id: string): Promise<ProjectConfig>;
  projectsUpdate(id: string, patch: ProjectPatch): Promise<ProjectConfig>;
  sessionsList(filters: SessionListFilters): Promise<SessionListResponse>;
  sessionsGet(source: Source, id: string): Promise<Session>;
  sessionsEvents(
    source: Source,
    id: string,
    opts?: { agentId?: string; afterSeq?: number; limit?: number },
  ): Promise<SessionEventsResponse>;
  sessionsAgents(source: Source, id: string): Promise<AgentNode[]>;
  sessionsResume(source: Source, id: string, body: ResumeRequest): Promise<ResumeResponse>;
  sessionsPin(source: Source, id: string, pinned: boolean): Promise<{ pinned: boolean }>;
  sessionsLabel(source: Source, id: string, labels: string[]): Promise<{ labels: string[] }>;
  labelsList(): Promise<string[]>;
  viewsList(): Promise<SavedView[]>;
  viewsSave(body: { name: string; query: Record<string, string> }): Promise<SavedView>;
  viewsDelete(id: string): Promise<{ ok: true }>;
  ptyList(): Promise<PtyInfo[]>;
  ptyKill(ptyId: string): Promise<{ ok: true }>;
}

export function toQueryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function createApiClient(o: ApiClientOptions): ApiClient & P2Methods {
  const doFetch: typeof fetch = o.fetch ?? ((input, init) => fetch(input, init));

  async function call<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'x-orc-token': o.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await doFetch(`${o.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const parsed = ApiError.safeParse(json);
      if (parsed.success) {
        const e = parsed.data.error;
        throw new ApiRequestError(res.status, e.code, e.message, e.details);
      }
      throw new ApiRequestError(res.status, 'http_error', `HTTP ${res.status}`);
    }
    return schema.parse(json);
  }

  const seg = (source: Source, id: string) =>
    `/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;

  const methods: ApiClient = {
    healthGet: () => call(HealthResponseSchema, 'GET', '/api/health'),
    projectsList: () => call(z.array(ProjectSchema), 'GET', '/api/projects'),
    projectsGet: (id) => call(ProjectConfig, 'GET', `/api/projects/${encodeURIComponent(id)}`),
    projectsUpdate: (id, patch) =>
      call(ProjectConfig, 'PATCH', `/api/projects/${encodeURIComponent(id)}`, patch),
    sessionsList: (filters) =>
      call(SessionListResponseSchema, 'GET', `/api/sessions${toQueryString(filters)}`),
    sessionsGet: (source, id) => call(SessionSchema, 'GET', seg(source, id)),
    sessionsEvents: (source, id, opts = {}) =>
      call(SessionEventsResponseSchema, 'GET', `${seg(source, id)}/events${toQueryString(opts)}`),
    sessionsAgents: (source, id) => call(z.array(AgentNodeSchema), 'GET', `${seg(source, id)}/agents`),
    sessionsResume: (source, id, body) =>
      call(ResumeResponseSchema, 'POST', `${seg(source, id)}/resume`, body),
    sessionsPin: (source, id, pinned) =>
      call(PinResponseSchema, 'POST', `${seg(source, id)}/pin`, { pinned }),
    sessionsLabel: (source, id, labels) =>
      call(LabelResponseSchema, 'POST', `${seg(source, id)}/label`, { labels }),
    labelsList: () => call(LabelsListSchema, 'GET', '/api/labels'),
    viewsList: () => call(z.array(SavedViewSchema), 'GET', '/api/views'),
    viewsSave: (body) => call(SavedViewSchema, 'POST', '/api/views', body),
    viewsDelete: (id) => call(OkSchema, 'DELETE', `/api/views/${encodeURIComponent(id)}`),
    ptyList: () => call(z.array(PtyInfoSchema), 'GET', '/api/pty'),
    ptyKill: (ptyId) => call(OkSchema, 'DELETE', `/api/pty/${encodeURIComponent(ptyId)}`, { confirm: true }),
  };
  return { ...methods, ...p2Methods(makeCaller({ baseUrl: o.baseUrl, token: o.token, fetchImpl: doFetch })) };
}
