import type { AuditEntry, DenyVerdict, Source } from '@orc/core';
import { z } from 'zod';
import { ApiRequestError } from './client.ts';
import { AuditEntrySchema, type AuditQuery } from './routes/audit.ts';
import { PlanContentSchema, PlanRefSchema, SessionLinksSchema } from './routes/links.ts';
import { type DenyCheckRequest, DenyVerdictSchema, SecretsReportSchema } from './routes/safety.ts';
import {
  FileSummarySchema,
  RawPageSchema,
  SessionSafetySchema,
  SessionStatsResponse,
  TurnDeliverablesSchema,
  UsagePointSchema,
} from './routes/session-detail.ts';

export interface P3ClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

/**
 * contracts §13: `ApiCallError` is not a separate class. Phase 3 throws P1's `ApiRequestError`;
 * the name is re-exported here only as an alias so the Phase 3 tests can import it.
 */
export { ApiRequestError as ApiCallError };

type Query = Record<string, string | number | boolean | null | undefined>;

function qs(q: Query): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;
const base = (source: Source, id: string) => `/api/sessions/${enc(source)}/${enc(id)}`;

export function createP3Methods(o: P3ClientOptions) {
  const doFetch = o.fetch ?? fetch;

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { 'x-orc-token': o.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await doFetch(`${o.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string; details?: unknown };
      } | null;
      throw new ApiRequestError(
        res.status,
        j?.error?.code ?? 'http_error',
        j?.error?.message ?? res.statusText,
        j?.error?.details,
      );
    }
    return res;
  }

  async function json<S extends z.ZodType>(
    schema: S,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<z.output<S>> {
    const res = await call(method, path, body);
    return schema.parse(await res.json()) as z.output<S>;
  }

  return {
    sessionsStats: (source: Source, id: string) =>
      json(SessionStatsResponse, 'GET', `${base(source, id)}/stats`),
    sessionsDeliverables: (source: Source, id: string) =>
      json(z.array(TurnDeliverablesSchema), 'GET', `${base(source, id)}/deliverables`),
    sessionsFiles: (source: Source, id: string) =>
      json(z.array(FileSummarySchema), 'GET', `${base(source, id)}/files`),
    sessionsUsageSeries: (source: Source, id: string) =>
      json(z.array(UsagePointSchema), 'GET', `${base(source, id)}/usage-series`),
    sessionsSafety: (source: Source, id: string) =>
      json(SessionSafetySchema, 'GET', `${base(source, id)}/safety`),
    sessionsLinks: (source: Source, id: string) =>
      json(SessionLinksSchema, 'GET', `${base(source, id)}/links`),
    sessionsRaw: (
      source: Source,
      id: string,
      q: { agentId?: string | null; offset?: number; limit?: number },
    ) =>
      json(
        RawPageSchema,
        'GET',
        `${base(source, id)}/raw${qs({ agentId: q.agentId, offset: q.offset, limit: q.limit })}`,
      ),
    sessionsExport: async (source: Source, id: string, opts: { redact: boolean }): Promise<Blob> => {
      const query = opts.redact ? '' : qs({ redact: 'false', confirm: 'true' });
      const res = await call('GET', `${base(source, id)}/export${query}`);
      return res.blob();
    },
    plansList: (q: string, limit = 20) =>
      json(z.array(PlanRefSchema), 'GET', `/api/plans${qs({ q, limit })}`),
    plansContent: (path: string) => json(PlanContentSchema, 'GET', `/api/plans/content${qs({ path })}`),
    auditList: (f: Partial<AuditQuery>): Promise<AuditEntry[]> =>
      json(z.array(AuditEntrySchema), 'GET', `/api/audit${qs(f)}`),
    safetySecrets: () => json(SecretsReportSchema, 'GET', '/api/safety/secrets'),
    safetyDenyCheck: (body: DenyCheckRequest): Promise<DenyVerdict> =>
      json(DenyVerdictSchema, 'POST', '/api/safety/deny-check', body),
  };
}

export type P3Methods = ReturnType<typeof createP3Methods>;
