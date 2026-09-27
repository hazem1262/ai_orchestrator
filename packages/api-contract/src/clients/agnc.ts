import { z } from 'zod';
import { AgncEventPage, AgncMessage, AgncSession, AgncStatus } from '../routes/agnc.ts';
import type { ApiCall } from './phase7.ts';

export interface AgncApi {
  agncStatus(): Promise<AgncStatus>;
  agncConnect(): Promise<{ authorizationUrl: string | null }>;
  agncMessages(id: string): Promise<AgncMessage[]>;
  agncEvents(id: string, cursor?: string): Promise<AgncEventPage>;
  agncPrompt(id: string, body: { prompt: string; model?: string }): Promise<{ ok: true }>;
  agncHandoff(body: {
    source: 'claude' | 'codex';
    id: string;
    repoOwner?: string;
    repoName?: string;
    baseBranch?: string;
    model?: string;
  }): Promise<AgncSession>;
}

const Connect = z.object({ authorizationUrl: z.string().nullable() });
const Ok = z.object({ ok: z.literal(true) });

export function agncClient(call: ApiCall): AgncApi {
  const s = (id: string) => `/api/agnc/sessions/${encodeURIComponent(id)}`;
  return {
    agncStatus: () => call(AgncStatus, 'GET', '/api/connectors/agnc/status'),
    agncConnect: () => call(Connect, 'POST', '/api/connectors/agnc/connect', {}),
    agncMessages: (id) => call(z.array(AgncMessage), 'GET', `${s(id)}/messages`),
    agncEvents: (id, cursor) =>
      call(AgncEventPage, 'GET', `${s(id)}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
    agncPrompt: (id, body) => call(Ok, 'POST', `${s(id)}/prompt`, { ...body, confirm: true }),
    agncHandoff: (body) => call(AgncSession, 'POST', '/api/agnc/handoff', { ...body, confirm: true }),
  };
}
