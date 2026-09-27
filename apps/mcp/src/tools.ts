import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DaemonClient } from './daemon-client.ts';

interface LiveSession {
  id: string;
  source: string;
  projectId: string | null;
  name: string | null;
  startCwd: string;
  lastActivityAt: string;
  recap?: string | null;
  awaySummary?: string | null;
  usage: { costUsd: number | null };
  tickets: string[];
  prs: Array<{ url: string }>;
  filesTouched?: string[];
  availability?: string;
  lastTest?: { passed: number; failed: number; skipped: number; command: string } | null;
  live: {
    status: string;
    waitingFor: string | null;
    ownership: string;
    ptyId: string | null;
    since: string;
  } | null;
}

interface InboxItem {
  id: string;
  kind: string;
  sessionId: string | null;
  projectId: string | null;
  ticket: string | null;
  reason: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface OrcToolsOptions {
  /** Base URL of the orchestrator web UI, used for the link `resume_session` returns. */
  webUrl?: string;
}

const DEFAULT_WEB_URL = 'http://127.0.0.1:4317';

const ATTENTION_KINDS = new Set([
  'waiting',
  'plan_approval',
  'review',
  'supervisor_escalation',
  'blocked',
  'error',
]);

const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export function resumeCommand(s: { source: string; id: string; startCwd: string }): string {
  const cmd = s.source === 'codex' ? `codex resume ${s.id}` : `claude --resume ${s.id}`;
  return `cd ${shellQuote(s.startCwd)} && ${cmd}`;
}

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const asError = (e: unknown) => ({
  content: [
    { type: 'text' as const, text: `orchestrator error: ${e instanceof Error ? e.message : String(e)}` },
  ],
  isError: true,
});

const summariseLive = (s: LiveSession) => ({
  pk: `${s.source}:${s.id}`,
  name: s.name,
  status: s.live?.status ?? 'ended',
  waitingFor: s.live?.waitingFor ?? null,
  projectId: s.projectId,
  cwd: s.startCwd,
  owned: s.live?.ownership === 'owned',
  costUsd: s.usage.costUsd,
  since: s.live?.since ?? s.lastActivityAt,
});

const sessionPath = (source: string, id: string) =>
  `/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;

export function registerOrcTools(server: McpServer, client: DaemonClient, opts: OrcToolsOptions = {}): void {
  const webUrl = (opts.webUrl ?? DEFAULT_WEB_URL).replace(/\/+$/, '');

  const run = async (fn: () => Promise<unknown>) => {
    try {
      return asText(await fn());
    } catch (e) {
      return asError(e);
    }
  };

  server.registerTool(
    'list_live_sessions',
    {
      title: 'List live sessions',
      description: 'Claude and Codex sessions that are currently running on this machine.',
      inputSchema: { projectId: z.string().optional() },
    },
    async ({ projectId }) =>
      run(async () => {
        const live = await client.get<LiveSession[]>('/api/live');
        return live.filter((s) => !projectId || s.projectId === projectId).map(summariseLive);
      }),
  );

  server.registerTool(
    'list_waiting',
    {
      title: 'List what needs me',
      description:
        'Open attention-inbox items: waiting sessions, plans to approve, reviews, supervisor escalations.',
      inputSchema: { projectId: z.string().optional() },
    },
    async ({ projectId }) =>
      run(async () => {
        const items = await client.get<InboxItem[]>('/api/inbox?state=open');
        return items
          .filter((i) => ATTENTION_KINDS.has(i.kind) && (!projectId || i.projectId === projectId))
          .map((i) => ({
            kind: i.kind,
            reason: i.reason,
            sessionId: i.sessionId,
            projectId: i.projectId,
            ticket: i.ticket,
            since: i.createdAt,
          }));
      }),
  );

  server.registerTool(
    'search_sessions',
    {
      title: 'Search past sessions',
      description: 'Full-text search over prompts, assistant text and tool inputs of every indexed session.',
      inputSchema: {
        query: z.string().min(1).max(200),
        projectId: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, projectId, limit }) =>
      run(async () => {
        const params = new URLSearchParams({ q: query, limit: String(limit ?? 10) });
        if (projectId) params.set('projectId', projectId);
        const res = await client.get<{ items: Array<Record<string, unknown>> }>(
          `/api/sessions?${params.toString()}`,
        );
        return res.items.map((i) => ({
          pk: i.pk,
          name: i.name,
          snippet: i.snippet,
          lastActivityAt: i.lastActivityAt,
          costUsd: i.costUsd,
          tickets: i.tickets,
        }));
      }),
  );

  server.registerTool(
    'get_session_summary',
    {
      title: 'Summarise a session',
      description: 'Recap, tickets, PRs, files, tests and the command to resume a session.',
      inputSchema: { source: z.enum(['claude', 'codex', 'agnc']), id: z.string().min(1) },
    },
    async ({ source, id }) =>
      run(async () => {
        const s = await client.get<LiveSession>(sessionPath(source, id));
        return {
          pk: `${source}:${id}`,
          name: s.name,
          status: s.live?.status ?? 'ended',
          projectId: s.projectId,
          cwd: s.startCwd,
          recap: s.recap ?? s.awaySummary ?? null,
          tickets: s.tickets,
          prs: s.prs.map((p) => p.url),
          files: (s.filesTouched ?? []).slice(0, 30),
          tests: s.lastTest ? `${s.lastTest.passed} passed, ${s.lastTest.failed} failed` : null,
          costUsd: s.usage.costUsd,
          availability: s.availability ?? null,
          resumeCommand: resumeCommand({ source, id, startCwd: s.startCwd }),
        };
      }),
  );

  server.registerTool(
    'get_stream',
    {
      title: 'Get a ticket work stream',
      description:
        'Everything the orchestrator knows about one ticket: sessions, PRs, plans, cost and stage.',
      inputSchema: { ticket: z.string().min(2) },
    },
    async ({ ticket }) => run(async () => client.get(`/api/streams/${encodeURIComponent(ticket)}`)),
  );

  server.registerTool(
    'resume_session',
    {
      title: 'Resume a session',
      description:
        'Returns the shell command that resumes a session. With launch=true the orchestrator starts it in its own terminal instead.',
      inputSchema: {
        source: z.enum(['claude', 'codex']),
        id: z.string().min(1),
        launch: z.boolean().optional(),
      },
    },
    async ({ source, id, launch }) =>
      run(async () => {
        const s = await client.get<LiveSession>(sessionPath(source, id));
        const command = resumeCommand({ source, id, startCwd: s.startCwd });
        if (!launch) return { command, cwd: s.startCwd, launched: false };
        const res = await client.post<{ ptyId?: string }>(`${sessionPath(source, id)}/resume`, {
          mode: 'embedded',
        });
        return {
          command,
          cwd: s.startCwd,
          launched: true,
          ptyId: res.ptyId ?? null,
          url: `${webUrl}/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}`,
        };
      }),
  );
}
