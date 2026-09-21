import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from './client.ts';
import { makeCaller, p2Methods } from './client-p2.ts';
import { OrcConfig } from './config.ts';
import { ArchiveRestoreBody, ArchiveRestoreResponse, ArchiveStatus } from './routes/archive.ts';
import { HookIngestBody } from './routes/hooks.ts';
import { InboxActionBody, InboxItemSchema, InboxListQuery } from './routes/inbox.ts';
import { ConfirmBody, KillResponse, LaunchRequest, LaunchResponse, OpenInBody } from './routes/launch.ts';
import { LiveListResponse } from './routes/live.ts';
import { NotificationPrefs } from './routes/notifications.ts';
import { TemplateSchema } from './routes/templates.ts';

describe('phase 2 config', () => {
  it('fills live config defaults', () => {
    expect(OrcConfig.parse({}).live).toEqual({
      pollMs: 1000,
      endedRetentionMin: 10,
      codexBusyWindowMs: 10000,
    });
  });
});

describe('LaunchRequest', () => {
  it('parses a launch request with defaults', () => {
    const r = LaunchRequest.parse({ source: 'claude', projectId: 'wakecap', cwd: '/tmp' });
    expect(r).toMatchObject({ prompt: '', vars: {}, planApproval: false });
    expect(r.templateId).toBeUndefined();
    expect(r.worktree).toBeUndefined();
    expect(r.compare).toBeUndefined();
  });

  it('rejects an invalid source and requires projectId to be present (string | null)', () => {
    expect(LaunchRequest.safeParse({ source: 'agnc', projectId: null, cwd: '/tmp' }).success).toBe(false);
    // projectId omitted entirely must fail: it's string | null, not optional
    expect(LaunchRequest.safeParse({ source: 'claude', cwd: '/tmp' }).success).toBe(false);
  });

  it('round-trips projectId null vs a session-bound worktree/compare request unchanged', () => {
    const input = {
      source: 'codex' as const,
      projectId: null,
      cwd: '/tmp/repo',
      prompt: 'do the thing',
      templateId: 'tpl-1',
      vars: { ticket: 'SAF-1' },
      ticket: 'SAF-1',
      model: 'gpt-5',
      planApproval: true,
      worktree: { repo: 'wakecap', base: 'main', type: 'feat' as const, slug: 'my-feature' },
      compare: [{ source: 'claude' as const, model: 'claude-sonnet-5' }],
    };
    const out = LaunchRequest.parse(input);
    expect(out).toEqual(input);
    expect(out.projectId).toBeNull();
  });

  it('rejects unknown top-level keys (strict request body)', () => {
    expect(
      LaunchRequest.safeParse({ source: 'claude', projectId: null, cwd: '/tmp', bogus: true }).success,
    ).toBe(false);
  });
});

describe('LaunchResponse / ConfirmBody / KillResponse / OpenInBody', () => {
  it('round-trips LaunchResponse with a null sessionId', () => {
    const v = { ptyId: 'p1', sessionId: null };
    expect(LaunchResponse.parse(v)).toEqual(v);
    expect(LaunchResponse.parse(v).sessionId).toBeNull();
  });

  it('rejects unknown keys on ConfirmBody', () => {
    expect(ConfirmBody.parse({})).toEqual({});
    expect(ConfirmBody.parse({ confirm: true })).toEqual({ confirm: true });
    expect(ConfirmBody.safeParse({ confirm: true, extra: 1 }).success).toBe(false);
  });

  it('round-trips KillResponse', () => {
    expect(KillResponse.parse({ killed: 'pty' })).toEqual({ killed: 'pty' });
  });

  it('defaults open-in remember to true and rejects unknown keys', () => {
    expect(OpenInBody.parse({ app: 'finder' })).toEqual({ app: 'finder', remember: true });
    expect(OpenInBody.safeParse({ app: 'finder', remember: false, extra: 1 }).success).toBe(false);
  });
});

describe('inbox schemas', () => {
  it('parses comma-separated inbox filters and rejects a bogus state', () => {
    expect(InboxListQuery.parse({ state: 'open,snoozed', kind: 'waiting' })).toEqual({
      state: ['open', 'snoozed'],
      kind: ['waiting'],
    });
    expect(InboxListQuery.safeParse({ state: 'bogus' }).success).toBe(false);
  });

  it('leaves inbox query fully optional', () => {
    expect(InboxListQuery.parse({})).toEqual({});
  });

  it('rejects unknown keys on InboxActionBody', () => {
    expect(InboxActionBody.parse({})).toEqual({});
    expect(InboxActionBody.safeParse({ until: '2026-01-01T00:00:00Z', extra: 1 }).success).toBe(false);
  });

  it('round-trips a fully-populated InboxItem, preserving null (not undefined) on nullable fields', () => {
    const item = {
      id: 'i1',
      kind: 'waiting' as const,
      sessionId: null,
      projectId: null,
      ticket: null,
      reason: 'Claude is waiting for input',
      dedupeKey: 'd1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      state: 'open' as const,
      snoozeUntil: null,
      payload: { lastMessage: 'do you want to proceed?' },
    };
    const out = InboxItemSchema.parse(item);
    expect(out).toEqual(item);
    expect(out.sessionId).toBeNull();
    expect(out.projectId).toBeNull();
    expect(out.ticket).toBeNull();
    expect(out.snoozeUntil).toBeNull();
    expect('sessionId' in out).toBe(true);
  });
});

describe('templates', () => {
  it('round-trips a TemplateDto', () => {
    const t = {
      id: 'tpl-1',
      kind: 'workflow' as const,
      label: 'Fix a ticket',
      prompt: 'Fix {{ticket}}',
      vars: ['ticket' as const],
      defaultSource: 'claude' as const,
      projectIds: 'all' as const,
    };
    expect(TemplateSchema.parse(t)).toEqual(t);
    const scoped = { ...t, projectIds: ['wakecap'] };
    expect(TemplateSchema.parse(scoped)).toEqual(scoped);
  });
});

describe('archive', () => {
  it('round-trips ArchiveStatus, including nulls', () => {
    const s = {
      enabled: true,
      files: 3,
      bytes: 1024,
      oldestTranscript: null,
      cleanupPeriodDays: null,
      codec: 'zstd' as const,
      recommendedSnippet: '{\n  "cleanupPeriodDays": 3650\n}',
    };
    expect(ArchiveStatus.parse(s)).toEqual(s);
  });

  it('rejects unknown keys on ArchiveRestoreBody', () => {
    expect(ArchiveRestoreBody.parse({ source: 'claude', id: 's1' })).toEqual({ source: 'claude', id: 's1' });
    expect(
      ArchiveRestoreBody.safeParse({ source: 'claude', id: 's1', confirm: true, extra: 1 }).success,
    ).toBe(false);
  });

  it('round-trips ArchiveRestoreResponse', () => {
    expect(ArchiveRestoreResponse.parse({ restored: ['a', 'b'] })).toEqual({ restored: ['a', 'b'] });
  });
});

describe('notifications', () => {
  it('round-trips NotificationPrefs', () => {
    const p = { 'inbox.waiting': { enabled: true, channels: ['macos' as const, 'slack_dm' as const] } };
    expect(NotificationPrefs.parse(p)).toEqual(p);
  });
});

describe('hooks', () => {
  it('keeps unknown hook fields (loose passthrough for external hook payloads)', () => {
    const h = HookIngestBody.parse({ session_id: 's', hook_event_name: 'Notification', cwd: '/x' });
    expect(h).toMatchObject({ session_id: 's', cwd: '/x' });
  });

  it('rejects a missing session_id', () => {
    expect(HookIngestBody.safeParse({ hook_event_name: 'Notification' }).success).toBe(false);
  });
});

describe('live', () => {
  it('validates a live list response against the real SessionSchema', () => {
    const session = {
      id: 's1',
      source: 'claude' as const,
      projectId: 'wakecap',
      startCwd: '/tmp',
      cwds: ['/tmp'],
      name: null,
      firstPrompt: null,
      lastPrompt: null,
      awaySummary: null,
      recap: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      models: [],
      permissionMode: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
      linesAdded: null,
      linesRemoved: null,
      prs: [],
      tickets: [],
      skills: [],
      mcpServers: [],
      filesTouched: [],
      promptCount: 0,
      toolCallCount: 0,
      apiErrorCount: 0,
      flags: { touchedProd: false, hasSubagents: false, automated: false },
      availability: 'resumable' as const,
      transcriptPath: null,
      lastTest: null,
      live: {
        pid: 123,
        status: 'busy' as const,
        waitingFor: null,
        since: '2026-01-01T00:00:00.000Z',
        ownership: 'owned' as const,
        ptyId: 'p1',
        stage: null,
        currentTool: null,
        backgroundJobs: 0,
        runningSubagents: 0,
        contextFill: null,
      },
    };
    expect(LiveListResponse.parse([session])).toEqual([session]);
  });
});

describe('client-p2', () => {
  it('calls the API with the token and parses errors as ApiRequestError (P1-owned, not a new class)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 'concurrency_limit', message: 'too many', details: { max: 1 } } }),
          { status: 429 },
        ),
      );
    const api = p2Methods(makeCaller({ baseUrl: 'http://127.0.0.1:4317', token: 't0k', fetchImpl }));
    await expect(api.inboxList({ state: ['open'], projectId: 'wakecap' })).resolves.toEqual([]);
    const [url, init] = fetchImpl.mock.calls[0] ?? [undefined, undefined];
    expect(String(url)).toBe('http://127.0.0.1:4317/api/inbox?state=open&projectId=wakecap');
    expect(new Headers(init?.headers).get('x-orc-token')).toBe('t0k');
    const err = await api
      .sessionsLaunch({ source: 'claude', projectId: null, cwd: '/tmp' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 429, code: 'concurrency_limit', details: { max: 1 } });
  });
});
