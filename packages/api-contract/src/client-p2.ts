import type { InboxItem, InboxKind, InboxState, Session, Source } from '@orc/core';
import { z } from 'zod';
import { ApiRequestError } from './client.ts';
import { ArchiveRestoreResponse, ArchiveStatus, ArchiveSyncResponse } from './routes/archive.ts';
import { InboxItemSchema } from './routes/inbox.ts';
import type { KillResponse, LaunchRequestInput, LaunchResponse, OpenInApp } from './routes/launch.ts';
import {
  KillResponse as KillResponseSchema,
  LaunchResponse as LaunchResponseSchema,
} from './routes/launch.ts';
import { LiveListResponse } from './routes/live.ts';
import { NotificationPrefs } from './routes/notifications.ts';
import { OkSchema } from './routes/sessions.ts';
import type { TemplateDto } from './routes/templates.ts';
import { TemplateSchema } from './routes/templates.ts';

/**
 * contracts §13: `ApiRequestError` is P1-owned (`./client.ts`) and every later phase must reuse it
 * rather than defining a parallel error class — the table explicitly rules out a name like
 * `ApiCallError` ("does not exist... delete that name where a plan uses it"). The phase-2 task
 * brief predates that ruling (it predates phase 1 shipping) and asked for `ApiCallError`; this file
 * re-exports `ApiRequestError` under that expectation instead of introducing a second class.
 */
export { ApiRequestError };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type Caller = <T>(method: HttpMethod, path: string, body?: unknown) => Promise<T>;

export function makeCaller(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch }): Caller {
  const f = opts.fetchImpl ?? fetch;
  return async <T>(method: HttpMethod, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { 'x-orc-token': opts.token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await f(`${opts.baseUrl}${path}`, {
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
      const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new ApiRequestError(
        res.status,
        e?.code ?? 'http_error',
        e?.message ?? res.statusText,
        e?.details,
      );
    }
    return json as T;
  };
}

function qs(params: Record<string, string | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

/** Typed phase-2 client methods, merged into `createApiClient`'s return value by `client.ts`. */
export function p2Methods(call: Caller) {
  return {
    liveList: () =>
      call<unknown>('GET', '/api/live').then((d) => LiveListResponse.parse(d)) as Promise<Session[]>,
    sessionsLaunch: (req: LaunchRequestInput) =>
      call<unknown>('POST', '/api/sessions/launch', req).then((d) =>
        LaunchResponseSchema.parse(d),
      ) as Promise<LaunchResponse>,
    sessionsKill: (source: Source, id: string, confirm: boolean) =>
      call<unknown>('POST', `/api/sessions/${source}/${enc(id)}/kill`, { confirm }).then((d) =>
        KillResponseSchema.parse(d),
      ) as Promise<KillResponse>,
    sessionsOpenIn: (source: Source, id: string, app: OpenInApp, remember = true) =>
      call<unknown>('POST', `/api/sessions/${source}/${enc(id)}/open-in`, { app, remember }).then((d) =>
        OkSchema.parse(d),
      ),
    inboxList: (f: { state?: InboxState[]; kind?: InboxKind[]; projectId?: string } = {}) =>
      call<unknown>(
        'GET',
        `/api/inbox${qs({ state: f.state?.join(','), kind: f.kind?.join(','), projectId: f.projectId })}`,
      ).then((d) => z.array(InboxItemSchema).parse(d)) as Promise<InboxItem[]>,
    inboxDone: (id: string) =>
      call<unknown>('POST', `/api/inbox/${enc(id)}/done`, {}).then((d) =>
        InboxItemSchema.parse(d),
      ) as Promise<InboxItem>,
    inboxSnooze: (id: string, until: string) =>
      call<unknown>('POST', `/api/inbox/${enc(id)}/snooze`, { until }).then((d) =>
        InboxItemSchema.parse(d),
      ) as Promise<InboxItem>,
    inboxReopen: (id: string) =>
      call<unknown>('POST', `/api/inbox/${enc(id)}/reopen`, {}).then((d) =>
        InboxItemSchema.parse(d),
      ) as Promise<InboxItem>,
    templatesList: (projectId?: string) =>
      call<unknown>('GET', `/api/templates${qs({ projectId })}`).then((d) =>
        z.array(TemplateSchema).parse(d),
      ) as Promise<TemplateDto[]>,
    archiveStatus: () => call<unknown>('GET', '/api/archive/status').then((d) => ArchiveStatus.parse(d)),
    archiveRestore: (source: Source, id: string, confirm: boolean) =>
      call<unknown>('POST', '/api/archive/restore', { source, id, confirm }).then((d) =>
        ArchiveRestoreResponse.parse(d),
      ),
    archiveSync: () =>
      call<unknown>('POST', '/api/archive/sync', {}).then((d) => ArchiveSyncResponse.parse(d)),
    notificationsGet: () =>
      call<unknown>('GET', '/api/config/notifications').then((d) => NotificationPrefs.parse(d)),
    notificationsPut: (prefs: NotificationPrefs) =>
      call<unknown>('PUT', '/api/config/notifications', prefs).then((d) => NotificationPrefs.parse(d)),
  };
}
export type P2Methods = ReturnType<typeof p2Methods>;
