import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentNodeSchema,
  ProjectSchema,
  SessionEventsResponseSchema,
  SessionListResponseSchema,
  SessionSchema,
} from '@orc/api-contract';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import { createFakeLive } from '../../test/fake-live.ts';
import {
  createTestContext,
  FAKE_CLAUDE,
  indexFixtures,
  type TestContext,
  writeClaudeSession,
} from '../../test/helpers.ts';
import { CENSUS } from '../../test/route-census.ts';
import { insertHistoryPrompts } from '../db/repos/history.ts';
import { createInboxEngine } from '../inbox/engine.ts';
import type { Indexer } from '../indexer/indexer.ts';
import { stubSession } from '../live/stub-session.ts';
import { createArchiveService } from '../services/archive/archive.ts';
import { createApp } from './app.ts';
import type { OrcApp } from './types.ts';

// Every temp dir this file makes is tracked and removed when the file's tests finish. Without
// this the suite leaked ~100 directories per `pnpm test` run; 10,870 of them once filled the
// disk and produced dozens of failures that looked like flaky tests.
const tmpDirs: string[] = [];
const tmpDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const TOKEN = 'a'.repeat(64);
const BASE = 'http://127.0.0.1:4317';
const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never;

let ctx: TestContext;
let indexer: Indexer;
let app: OrcApp;

beforeEach(async () => {
  ctx = createTestContext();
  indexer = await indexFixtures(ctx);
  app = createApp({ ctx, token: TOKEN, port: () => 4317, env: {} });
});
afterEach(async () => {
  await indexer.close();
  ctx.dispose();
});

function call(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; base?: string } = {},
) {
  const headers: Record<string, string> = { 'x-orc-token': TOKEN, ...(init.headers ?? {}) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return app.request(`${init.base ?? BASE}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

const SECRET_SESSION_ID = 's-secret';

function secretSessionDir(ctx: TestContext): { cwd: string; dir: string } {
  const cwd = join(ctx.homes.root, 'work', 'secret');
  const dir = join(ctx.homes.claudeHome, 'projects', cwd.replace(/[/._ ]/g, '-'));
  return { cwd, dir };
}

/** Writes a raw Claude transcript with two user turns and an assistant text reply, each secret-bearing. */
function writeSecretSession(ctx: TestContext): string {
  const sessionId = SECRET_SESSION_ID;
  const { cwd, dir } = secretSessionDir(ctx);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  const records = [
    {
      type: 'user',
      uuid: 'sec-u1',
      parentUuid: null,
      isSidechain: false,
      sessionId,
      timestamp: '2026-09-05T09:00:00.000Z',
      cwd,
      message: { role: 'user', content: 'Investigate prod outage using PGPASSWORD=hunter2 to connect.' },
    },
    {
      type: 'assistant',
      uuid: 'sec-a1',
      parentUuid: 'sec-u1',
      isSidechain: false,
      sessionId,
      timestamp: '2026-09-05T09:00:05.000Z',
      cwd,
      message: {
        id: 'msg-sec-1',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'Found the leaked token ghp_1234567890abcdefghij in the logs.' }],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    {
      type: 'user',
      uuid: 'sec-u2',
      parentUuid: 'sec-a1',
      isSidechain: false,
      sessionId,
      timestamp: '2026-09-05T09:00:10.000Z',
      cwd,
      message: { role: 'user', content: 'Also rotate the AWS key AKIAABCDEFGHIJKLMNOP while you are at it.' },
    },
    {
      // Fix round 5: `tool` carries a user-configured MCP server segment and `cwd` drift is
      // transcript-derived — both reached the API raw before this round.
      type: 'assistant',
      uuid: 'sec-a2',
      parentUuid: 'sec-u2',
      isSidechain: false,
      sessionId,
      timestamp: '2026-09-05T09:00:15.000Z',
      cwd: `${cwd}/PGPASSWORD=hunter2cwd`,
      message: {
        id: 'msg-sec-2',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          {
            type: 'tool_use',
            id: 'sec-tu2',
            name: 'mcp__PGPASSWORD=hunter2tool__run',
            input: { note: 'ok' },
          },
          // skills and filesTouched are transcript-derived too (Fix round 5b).
          { type: 'tool_use', id: 'sec-tu3', name: 'Skill', input: { skill: 'PGPASSWORD=hunter2skill' } },
          {
            type: 'tool_use',
            id: 'sec-tu4',
            name: 'Edit',
            input: { file_path: '/tmp/PGPASSWORD=hunter2file.txt', old_string: 'a', new_string: 'b' },
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  ];
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}

/** Writes a subagent whose meta.json `description` (Agent tool-call input) also carries secrets. */
function writeSecretSubagent(ctx: TestContext): string {
  const { cwd, dir } = secretSessionDir(ctx);
  const subDir = join(dir, SECRET_SESSION_ID, 'subagents');
  mkdirSync(subDir, { recursive: true });
  const meta = {
    // agentType is transcript-derived too, not a fixed enum (Fix round 5).
    agentType: 'general-purpose-Ghp_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    description: 'Rotate PGPASSWORD=hunter2 and revoke ghp_1234567890abcdefghij',
    toolUseId: 'sec-agent-tu1',
    parentAgentId: null,
    spawnDepth: 1,
  };
  writeFileSync(join(subDir, 'agent-ag-secret.meta.json'), JSON.stringify(meta));
  const jsonlPath = join(subDir, 'agent-ag-secret.jsonl');
  const record = {
    type: 'user',
    uuid: 'agsec-u1',
    parentUuid: null,
    isSidechain: true,
    sessionId: SECRET_SESSION_ID,
    agentId: 'ag-secret',
    timestamp: '2026-09-05T09:00:06.000Z',
    cwd,
    message: { role: 'user', content: 'investigate the rotation' },
  };
  writeFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
  return jsonlPath;
}

const MIXED_CASE_TOKEN = `Ghp_${'e'.repeat(36)}`;
const SECRETS = ['hunter2', 'ghp_1234567890abcdefghij', 'AKIAABCDEFGHIJKLMNOP', MIXED_CASE_TOKEN];

describe('auth and errors', () => {
  it('requires the token, an allowed host and an allowed origin', async () => {
    expect((await app.request(`${BASE}/api/health`)).status).toBe(401);
    expect((await call('/api/health', { headers: { 'x-orc-token': 'wrong' } })).status).toBe(401);
    expect((await call('/api/health', { base: 'http://evil.test:4317' })).status).toBe(403);
    expect((await call('/api/health', { headers: { origin: 'http://evil.test' } })).status).toBe(403);
    const ok = await call('/api/health', { headers: { origin: 'http://localhost:4317' } });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ ok: true, version: '0.0.0' });
  });

  it('uses the error shape', async () => {
    const res = await call('/api/nope');
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: { code: 'not_found', message: 'no such route' } });
    const bad = await call('/api/sessions?limit=9999');
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('serves bootstrap.js only to same-origin loopback requests', async () => {
    const ok = await app.request(`${BASE}/bootstrap.js`, {}, LOOPBACK_ENV);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('javascript');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.text()).toBe(`window.__ORC_TOKEN__ = "${TOKEN}";\n`);
    const cross = await app.request(
      `${BASE}/bootstrap.js`,
      { headers: { 'sec-fetch-site': 'cross-site' } },
      LOOPBACK_ENV,
    );
    expect(cross.status).toBe(403);
    const remote = await app.request(`${BASE}/bootstrap.js`, {}, {
      incoming: { socket: { remoteAddress: '10.0.0.5' } },
    } as never);
    expect(remote.status).toBe(403);
    expect((await app.request('http://evil.test:4317/bootstrap.js', {}, LOOPBACK_ENV)).status).toBe(403);
  });
});

describe('projects', () => {
  it('lists and patches projects', async () => {
    const list = z.array(ProjectSchema).parse(await json(await call('/api/projects')));
    expect(list.map((p) => p.id)).toEqual(
      expect.arrayContaining(['wakecap', 'forza', 'stocks', 'hackathon']),
    );
    expect(list[0]?.id).toBe('wakecap');
    const res = await call('/api/projects/forza', {
      method: 'PATCH',
      body: { name: 'Forza App', hidden: true },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id: 'forza', name: 'Forza App', hidden: true });
    expect((await call('/api/projects/nope', { method: 'PATCH', body: { name: 'x' } })).status).toBe(404);
    // Controller ruling: unify on 422 for an unrecognised body key everywhere, including this
    // pre-existing strict schema — the brief's own literal test here expected 400, but shipping
    // two status conventions for the same failure class (typo'd key) forces every client to
    // special-case one route. `ticketRegex` below stays 400: it's a recognised key whose value
    // fails a semantic check unrelated to strict-object unknown-key rejection.
    expect((await call('/api/projects/forza', { method: 'PATCH', body: { id: 'x' } })).status).toBe(422);
    expect((await call('/api/projects/forza', { method: 'PATCH', body: { ticketRegex: '(' } })).status).toBe(
      400,
    );
  });
});

describe('sessions', () => {
  it('lists with filters, search snippets and redaction', async () => {
    const list = SessionListResponseSchema.parse(
      await json(await call('/api/sessions?projectId=wakecap&limit=2')),
    );
    expect(list.items.map((i) => i.pk)).toEqual(['claude:s-subagents', 'claude:s-unknown']);
    expect(list.nextCursor).not.toBeNull();
    const found = SessionListResponseSchema.parse(await json(await call('/api/sessions?q=notification')));
    expect(found.items[0]?.snippet).toContain('⟦notification⟧');
    const psql = SessionListResponseSchema.parse(await json(await call('/api/sessions?q=psql')));
    expect(psql.items.map((i) => i.pk)).toEqual(['claude:s-drift']);
    expect(psql.items[0]?.snippet).toContain('«redacted:secret»');
    expect(JSON.stringify(psql)).not.toContain('hunter2');
  });

  it('gets a session, its events and agents', async () => {
    expect((await call('/api/sessions/claude/nope')).status).toBe(404);
    expect((await call('/api/sessions/cursor/x')).status).toBe(400);
    const s = SessionSchema.parse(await json(await call('/api/sessions/claude/s-basic')));
    expect(s.name).toBe('Notification service test check');
    const ev = SessionEventsResponseSchema.parse(
      await json(await call('/api/sessions/claude/s-basic/events?limit=4')),
    );
    expect(ev.items.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(ev.nextSeq).toBe(4);
    const next = SessionEventsResponseSchema.parse(
      await json(await call('/api/sessions/claude/s-basic/events?afterSeq=4')),
    );
    expect(next.items[0]?.seq).toBe(5);
    const drift = await json(await call('/api/sessions/claude/s-drift/events'));
    expect(JSON.stringify(drift)).toContain('«redacted:secret»');
    expect(JSON.stringify(drift)).not.toContain('hunter2');
    const sub = SessionEventsResponseSchema.parse(
      await json(await call('/api/sessions/claude/s-subagents/events?agentId=ag1')),
    );
    expect(sub.items.every((e) => e.agentId === 'ag1')).toBe(true);
    const agents = z
      .array(AgentNodeSchema)
      .parse(await json(await call('/api/sessions/claude/s-subagents/agents')));
    expect(agents).toHaveLength(3);
  });

  it('pins, labels and hides sessions', async () => {
    expect(
      await json(await call('/api/sessions/claude/s-basic/pin', { method: 'POST', body: { pinned: true } })),
    ).toEqual({
      pinned: true,
    });
    const pinned = SessionListResponseSchema.parse(await json(await call('/api/sessions?pinned=true')));
    expect(pinned.items.map((i) => [i.pk, i.pinned])).toEqual([['claude:s-basic', true]]);
    expect(
      await json(
        await call('/api/sessions/claude/s-basic/label', {
          method: 'POST',
          body: { labels: ['hidden', 'later'] },
        }),
      ),
    ).toEqual({ labels: ['hidden', 'later'] });
    const visible = SessionListResponseSchema.parse(
      await json(await call('/api/sessions?projectId=wakecap')),
    );
    expect(visible.items.map((i) => i.pk)).not.toContain('claude:s-basic');
    const withHidden = SessionListResponseSchema.parse(
      await json(await call('/api/sessions?projectId=wakecap&includeHidden=true')),
    );
    expect(withHidden.items.find((i) => i.pk === 'claude:s-basic')?.labels).toEqual(['hidden', 'later']);
    expect(await json(await call('/api/labels'))).toEqual(['hidden', 'later']);
    expect(
      (await call('/api/sessions/claude/nope/pin', { method: 'POST', body: { pinned: true } })).status,
    ).toBe(404);
    expect(
      (await call('/api/sessions/claude/s-basic/pin', { method: 'POST', body: { pinned: 'yes' } })).status,
    ).toBe(400);
  });

  it('saves and deletes views', async () => {
    const saved = (await json(
      await call('/api/views', { method: 'POST', body: { name: 'Prod', query: { touchedProd: 'true' } } }),
    )) as { id: string };
    expect(await json(await call('/api/views'))).toEqual([
      expect.objectContaining({ name: 'Prod', query: { touchedProd: 'true' } }),
    ]);
    expect(await json(await call(`/api/views/${saved.id}`, { method: 'DELETE' }))).toEqual({ ok: true });
    expect((await call(`/api/views/${saved.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('resumes into a PTY and kills it with confirmation', async () => {
    const notResumable = await call('/api/sessions/claude/s-old-prompts-only/resume', {
      method: 'POST',
      body: { mode: 'embedded' },
    });
    expect(notResumable.status).toBe(409);
    expect(await json(notResumable)).toMatchObject({ error: { code: 'not_resumable' } });
    expect(
      (await call('/api/sessions/claude/s-basic/resume', { method: 'POST', body: { mode: 'tmux' } })).status,
    ).toBe(400);

    const cwd = join(ctx.homes.root, 'work', 'api');
    await indexer.indexFile(writeClaudeSession(ctx.homes, { sessionId: 's-api', cwd, prompt: 'api resume' }));
    const res = await call('/api/sessions/claude/s-api/resume', {
      method: 'POST',
      body: { mode: 'embedded' },
    });
    expect(res.status).toBe(200);
    const { ptyId } = (await json(res)) as { ptyId: string };
    const ptys = (await json(await call('/api/pty'))) as Array<{ id: string; sessionPk: string }>;
    expect(ptys).toEqual([expect.objectContaining({ id: ptyId, sessionPk: 'claude:s-api' })]);

    const unconfirmed = await call(`/api/pty/${ptyId}`, { method: 'DELETE' });
    expect(unconfirmed.status).toBe(409);
    expect(await json(unconfirmed)).toMatchObject({
      error: {
        code: 'confirmation_required',
        details: { summary: expect.stringContaining('--resume s-api') },
      },
    });
    expect(
      await json(await call(`/api/pty/${ptyId}`, { method: 'DELETE', body: { confirm: true } })),
    ).toEqual({ ok: true });
    expect(await json(await call('/api/pty'))).toEqual([]);
    expect((await call('/api/pty/nope', { method: 'DELETE', body: { confirm: true } })).status).toBe(404);
  });
});

describe('redaction at the boundary', () => {
  it('never leaks a secret from name, firstPrompt, lastPrompt, event text or a subagent description', async () => {
    await indexer.indexFile(writeSecretSession(ctx));
    await indexer.indexFile(writeSecretSubagent(ctx));

    const detail = await call('/api/sessions/claude/s-secret');
    expect(detail.status).toBe(200);
    const session = SessionSchema.parse(await json(detail));
    expect(session.name).not.toBeNull();
    expect(session.firstPrompt).toContain('«redacted:secret»');
    expect(session.lastPrompt).toContain('«redacted:aws»');

    const list = SessionListResponseSchema.parse(
      await json(await call('/api/sessions?source=claude&limit=200')),
    );
    const item = list.items.find((i) => i.pk === 'claude:s-secret');
    expect(item).toBeDefined();

    const events = await json(await call('/api/sessions/claude/s-secret/events'));
    const eventsText = JSON.stringify(events);
    expect(eventsText).toContain('«redacted:github»');

    const agentsRes = await call('/api/sessions/claude/s-secret/agents');
    expect(agentsRes.status).toBe(200);
    const agents = z.array(AgentNodeSchema).parse(await json(agentsRes));
    const secretAgent = agents.find((a) => a.id === 'ag-secret');
    expect(secretAgent).toBeDefined();
    expect(secretAgent?.description).toContain('«redacted:secret»');
    expect(secretAgent?.description).toContain('«redacted:github»');
    const agentsText = JSON.stringify(agents);

    // Fix round 5: tool name, agentType and cwds are transcript-derived too.
    expect(eventsText).toContain('mcp__PGPASSWORD=«redacted:secret»');
    expect(secretAgent?.agentType).toContain('«redacted:github»');
    expect(session.cwds.join(' ')).toContain('«redacted:secret»');
    // Fix round 5b: startCwd (sibling of cwds), skills and filesTouched were still raw.
    expect(session.skills.join(' ')).toContain('«redacted:secret»');
    expect(session.filesTouched.join(' ')).toContain('«redacted:secret»');

    const everything = [JSON.stringify(session), JSON.stringify(item), eventsText, agentsText].join('\n');
    for (const secret of SECRETS) {
      expect(everything).not.toContain(secret);
    }
    // The drifted cwd and the tool name must not survive anywhere in any response either.
    for (const raw of [
      'PGPASSWORD=hunter2cwd',
      'PGPASSWORD=hunter2tool',
      'PGPASSWORD=hunter2skill',
      'PGPASSWORD=hunter2file',
    ]) {
      expect(everything).not.toContain(raw);
    }
  });

  it('never leaks a secret through the history-prompt search fallback either (Fix round 4)', async () => {
    // Same session, same secrets, plus a history_prompts row (h.display: what sessions.ts's
    // `!hits.has(h.pk)` fallback renders — the exact path Fix round 4 found shipping raw,
    // unredacted text). Its own token ("historysentinel") appears nowhere in the indexed event
    // text, so the FTS-native `searchEventSessions` never matches it for this session and the
    // search MUST go through the history-prompt fallback to find it at all — proving this test
    // actually exercises that branch through the real HTTP pipeline, not just the native path
    // the previous test already covers.
    await indexer.indexFile(writeSecretSession(ctx));
    await indexer.indexFile(writeSecretSubagent(ctx));
    insertHistoryPrompts(ctx.db, [
      {
        sessionId: SECRET_SESSION_ID,
        ts: '2026-09-05T09:00:00.000Z',
        // The secret sits exactly 30 chars before the matched token — inside highlight()'s
        // default ±40-char radius, reproducing the same bisection Fix round 4 found: under the
        // old (buggy, unredacted) fallback this leaves "hunter2" in clear even after the
        // HTTP-boundary `redactSnippet` pass, because that pass runs on the already-bisected
        // text, not the original.
        display: `PGPASSWORD=hunter2${' '.repeat(30)}historysentinel followup text ghp_1234567890abcdefghij trailing`,
        project: '/Users/test/Wakecap',
      },
    ]);

    const list = SessionListResponseSchema.parse(
      await json(await call('/api/sessions?source=claude&q=historysentinel')),
    );
    const item = list.items.find((i) => i.pk === 'claude:s-secret');
    expect(item).toBeDefined(); // only findable via the history-prompt fallback (see above)
    expect(item?.snippet).not.toBeNull();
    // The snippet's ±40-char window can bisect the (short, post-redaction) tag itself — harmless,
    // since a tag fragment carries no secret data — so this only asserts the property that
    // actually matters: neither secret ever appears in clear, regardless of where the window
    // lands relative to the tag.
    expect(item?.snippet).not.toContain('hunter2');
    expect(item?.snippet).not.toMatch(/ghp_[A-Za-z0-9]/);

    const detail = await call('/api/sessions/claude/s-secret');
    const session = SessionSchema.parse(await json(detail));
    const events = await json(await call('/api/sessions/claude/s-secret/events'));
    const agentsRes = await call('/api/sessions/claude/s-secret/agents');
    const agents = z.array(AgentNodeSchema).parse(await json(agentsRes));

    const everything = [
      JSON.stringify(session),
      JSON.stringify(list),
      JSON.stringify(events),
      JSON.stringify(agents),
    ].join('\n');
    for (const secret of SECRETS) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe('strict request bodies', () => {
  it('rejects an unknown key with 422 validation_failed', async () => {
    const resume = await call('/api/sessions/claude/s-basic/resume', {
      method: 'POST',
      body: { mode: 'embedded', frok: true },
    });
    expect(resume.status).toBe(422);
    expect(await json(resume)).toMatchObject({ error: { code: 'validation_failed' } });

    const pin = await call('/api/sessions/claude/s-basic/pin', {
      method: 'POST',
      body: { pinned: true, extra: 1 },
    });
    expect(pin.status).toBe(422);

    const label = await call('/api/sessions/claude/s-basic/label', {
      method: 'POST',
      body: { labels: ['a'], oops: 'x' },
    });
    expect(label.status).toBe(422);

    const view = await call('/api/views', {
      method: 'POST',
      body: { name: 'x', query: {}, bogus: true },
    });
    expect(view.status).toBe(422);
  });
});

describe('static web app', () => {
  it('serves files with SPA fallback', async () => {
    const dist = tmpDir('orc-web-');
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Orchestrator</title>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    const web = createApp({ ctx, token: TOKEN, port: () => 4317, env: {}, webDist: dist });
    const index = await web.request(`${BASE}/`);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('Orchestrator');
    const js = await web.request(`${BASE}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(await (await web.request(`${BASE}/history?q=x`)).text()).toContain('Orchestrator');
    expect(await (await web.request(`${BASE}/assets/..%2f..%2findex.db`)).text()).toContain('Orchestrator');
    const missing = createApp({ ctx, token: TOKEN, port: () => 4317, env: {}, webDist: join(dist, 'nope') });
    expect((await missing.request(`${BASE}/`)).status).toBe(404);
  });
});

/**
 * The final link in the redaction chain, DERIVED FROM THE CENSUS.
 *
 * `redact-out.test.ts` proves each redactor redacts and that each route declares one. Neither
 * ties a declaration to the handler: measured, dropping `.map(redactPtyInfo)`,
 * `.map(redactProject)`, `.map(redactSavedView)`, `redactLabels(…)`, `redactResume(…)` or the 409
 * summary's redaction each left the whole suite green, while the same edit to phase 1's
 * `.map(redactListItem)` failed two tests — because phase 1 had a probe like this and those six
 * did not.
 *
 * The first version of this block hand-named nine surfaces, which protected what existed and
 * nothing new: a CENSUS row naming a redactor its handler never calls still passed. So the probes
 * are keyed on `CENSUS` itself. Every row with a `guardedBy` must have one, `has a probe for
 * every guarded route` fails if it does not, and each probe must show a redaction tag in its own
 * response — a seed that never lands is not a pass.
 *
 * One `it` per route, so different mutants fail different tests rather than all crowding into one.
 */
describe('route-level redaction, derived from the census', () => {
  const S = (name: string) => `ghp_${name}`.padEnd(24, 'x');
  const REDACTED = '«redacted:';

  interface Probe {
    /** Seeds, calls the route, asserts its own shape, and returns what to sweep. */
    run(): Promise<{ bodies: unknown[]; mustContain: string; mustNotContain: string[] }>;
  }

  const secretSession = async () => {
    await indexer.indexFile(writeSecretSession(ctx));
    await indexer.indexFile(writeSecretSubagent(ctx));
  };

  const seedPty = () => {
    const arg = S('ptyarg');
    const cwd = join(ctx.homes.root, 'work', S('ptycwd'));
    mkdirSync(cwd, { recursive: true });
    return { arg, cwd, info: ctx.pty.spawn({ command: FAKE_CLAUDE, args: ['--flag', arg], cwd }) };
  };

  const seedResumableCwd = async () => {
    const cwd = join(ctx.homes.root, 'work', S('resumecwd'));
    await indexer.indexFile(
      writeClaudeSession(ctx.homes, { sessionId: 's-rcwd', cwd, prompt: 'resume redaction' }),
    );
    return cwd;
  };

  const seedInbox = () => {
    const ticket = S('inboxticket');
    const command = S('inboxcmd');
    const engine = createInboxEngine(ctx);
    ctx.inbox = engine;
    const item = engine.upsert({
      kind: 'tests_red',
      scope: { session: 'claude:s-inbox' },
      ticket,
      reason: 'r',
      payload: { command },
    });
    return { id: item.id, secrets: [ticket, command] };
  };

  const PROBES: Record<string, Probe> = {
    'GET /api/live': {
      run: async () => {
        const prompt = S('liveprompt');
        ctx.live = createFakeLive([
          {
            ...stubSession({
              source: 'claude',
              id: 's-live',
              cwd: '/tmp/live',
              startedAt: '2026-09-01T09:00:00.000Z',
              projectId: null,
              name: 's-live',
            }),
            lastPrompt: prompt,
          },
        ]);
        const body = (await json(await call('/api/live'))) as Array<{ lastPrompt: string }>;
        expect(body[0]?.lastPrompt).toBe('«redacted:github»');
        return { bodies: [body], mustContain: REDACTED, mustNotContain: [prompt] };
      },
    },
    'GET /api/inbox': {
      run: async () => {
        const { id, secrets } = seedInbox();
        const body = await json(await call('/api/inbox'));
        expect(JSON.stringify(body)).toContain(id);
        return { bodies: [body], mustContain: REDACTED, mustNotContain: secrets };
      },
    },
    'POST /api/inbox/:id/:action{done|snooze|reopen}': {
      run: async () => {
        const { id, secrets } = seedInbox();
        const until = new Date(Date.now() + 3_600_000).toISOString();
        const bodies: unknown[] = [];
        for (const [action, body] of [
          ['snooze', { until }],
          ['done', {}],
          ['reopen', {}],
        ] as const) {
          const res = await call(`/api/inbox/${id}/${action}`, { method: 'POST', body });
          expect(res.status, action).toBe(200);
          bodies.push(await json(res));
        }
        return { bodies, mustContain: REDACTED, mustNotContain: secrets };
      },
    },
    'GET /api/sessions': {
      run: async () => {
        await secretSession();
        const body = await json(await call('/api/sessions?source=claude&limit=200'));
        return { bodies: [body], mustContain: REDACTED, mustNotContain: SECRETS };
      },
    },
    'GET /api/sessions/:source/:id': {
      run: async () => {
        await secretSession();
        const body = await json(await call(`/api/sessions/claude/${SECRET_SESSION_ID}`));
        return { bodies: [body], mustContain: REDACTED, mustNotContain: SECRETS };
      },
    },
    'GET /api/sessions/:source/:id/events': {
      run: async () => {
        await secretSession();
        const body = await json(await call(`/api/sessions/claude/${SECRET_SESSION_ID}/events`));
        return { bodies: [body], mustContain: REDACTED, mustNotContain: SECRETS };
      },
    },
    'GET /api/sessions/:source/:id/agents': {
      run: async () => {
        await secretSession();
        const body = await json(await call(`/api/sessions/claude/${SECRET_SESSION_ID}/agents`));
        return { bodies: [body], mustContain: REDACTED, mustNotContain: SECRETS };
      },
    },
    'POST /api/sessions/:source/:id/resume': {
      run: async () => {
        await seedResumableCwd();
        const res = await call('/api/sessions/claude/s-rcwd/resume', {
          method: 'POST',
          body: { mode: 'external' },
        });
        expect(res.status).toBe(200);
        const body = (await json(res)) as { command: string };
        expect(body.command).toContain(REDACTED);
        return { bodies: [body], mustContain: REDACTED, mustNotContain: [S('resumecwd')] };
      },
    },
    'POST /api/sessions/:source/:id/label': {
      run: async () => {
        const label = S('labelvalue');
        const body = (await json(
          await call('/api/sessions/claude/s-basic/label', { method: 'POST', body: { labels: [label] } }),
        )) as { labels: string[] };
        expect(body.labels).toEqual(['«redacted:github»']);
        return { bodies: [body], mustContain: REDACTED, mustNotContain: [label] };
      },
    },
    'GET /api/labels': {
      run: async () => {
        const label = S('labelvalue');
        await call('/api/sessions/claude/s-basic/label', { method: 'POST', body: { labels: [label] } });
        const body = await json(await call('/api/labels'));
        return { bodies: [body], mustContain: REDACTED, mustNotContain: [label] };
      },
    },
    'GET /api/projects': {
      run: async () => {
        const name = S('projname');
        const prefix = S('projprefix');
        ctx.projects.update('wakecap', { name, pathPrefixes: [`/tmp/${prefix}`] });
        const body = (await json(await call('/api/projects'))) as Array<{
          id: string;
          name: string;
          pathPrefixes: string[];
        }>;
        const wakecap = body.find((p) => p.id === 'wakecap');
        expect(wakecap?.name).toBe('«redacted:github»');
        expect(wakecap?.pathPrefixes).toEqual(['/tmp/«redacted:github»']);
        return { bodies: [body], mustContain: REDACTED, mustNotContain: [name, prefix] };
      },
    },
    'GET /api/pty': {
      run: async () => {
        const { arg, cwd } = seedPty();
        const body = (await json(await call('/api/pty'))) as Array<{ args: string[] }>;
        expect(body[0]?.args).toEqual(['--flag', '«redacted:github»']);
        return { bodies: [body], mustContain: REDACTED, mustNotContain: [arg, cwd] };
      },
    },
    'DELETE /api/pty/:ptyId': {
      run: async () => {
        const { arg, cwd, info } = seedPty();
        const res = await call(`/api/pty/${info.id}`, { method: 'DELETE' });
        expect(res.status).toBe(409);
        const body = (await json(res)) as { error: { details: { summary: string } } };
        // The 409 summary repeats the same argv and cwd. It is redacted twice — at the throw site
        // and again by `app.ts`'s error boundary — so removing either layer alone still produces
        // correct output. Both layers call the same `redact()`, so the redundancy is duplicate
        // rather than diverse: it is not two chances against a pattern gap. Removing BOTH fails.
        expect(body.error.details.summary).toContain(REDACTED);
        ctx.pty.remove(info.id);
        return { bodies: [body], mustContain: REDACTED, mustNotContain: [arg, cwd] };
      },
    },
    'POST /api/archive/restore': {
      run: async () => {
        const dir = join(ctx.homes.claudeHome, 'projects', `-work-${S('archdir')}`);
        mkdirSync(dir, { recursive: true });
        const target = join(dir, 's-arch.jsonl');
        writeFileSync(target, '{"type":"user"}\n');
        ctx.archive = createArchiveService(ctx, { codec: 'gzip' });
        await ctx.archive.syncAll();
        rmSync(target);
        const ask = await call('/api/archive/restore', {
          method: 'POST',
          body: { source: 'claude', id: 's-arch' },
        });
        expect(ask.status).toBe(409);
        const ok = await call('/api/archive/restore', {
          method: 'POST',
          body: { source: 'claude', id: 's-arch', confirm: true },
        });
        expect(ok.status).toBe(200);
        const again = await call('/api/archive/restore', {
          method: 'POST',
          body: { source: 'claude', id: 's-arch', confirm: true },
        });
        expect(again.status).toBe(409);
        const bodies = [await json(ask), await json(ok), await json(again)];
        return { bodies, mustContain: REDACTED, mustNotContain: [S('archdir')] };
      },
    },
    'GET /api/views': {
      run: async () => {
        const name = S('viewname');
        await call('/api/views', { method: 'POST', body: { name, query: { q: 'plain' } } });
        const body = await json(await call('/api/views'));
        return { bodies: [body], mustContain: REDACTED, mustNotContain: [name] };
      },
    },
    'POST /api/views': {
      run: async () => {
        const name = S('viewname');
        const body = (await json(
          await call('/api/views', { method: 'POST', body: { name, query: { q: 'plain' } } }),
        )) as { name: string };
        expect(body.name).toBe('«redacted:github»');
        return { bodies: [body], mustContain: REDACTED, mustNotContain: [name] };
      },
    },
  };

  it('has a probe for every guarded route in the census', () => {
    const guarded = Object.entries(CENSUS)
      .filter(([, e]) => e.guardedBy !== null)
      .map(([route]) => route);
    expect(guarded.filter((r) => !(r in PROBES))).toEqual([]);
    // And no probe for a route the census does not declare guarded, which would mean this list
    // and that one have drifted.
    expect(Object.keys(PROBES).filter((r) => CENSUS[r]?.guardedBy == null)).toEqual([]);
  });

  for (const [route, probe] of Object.entries(PROBES)) {
    it(`${route} serves no raw sentinel`, async () => {
      const { bodies, mustContain, mustNotContain } = await probe.run();
      const text = JSON.stringify(bodies);
      expect(text, 'the seed never reached this route, so the sweep below proves nothing').toContain(
        mustContain,
      );
      for (const secret of mustNotContain) expect(text).not.toContain(secret);
    });
  }
});

describe('the error channel', () => {
  const LEAK_KEY = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

  it('redacts an attacker-supplied key name echoed back by a 422', async () => {
    // `readJson` puts zod's issues in `details` AND the first issue's message in the response
    // message, and `unrecognized_keys` carries the offending KEY NAMES — which are whatever the
    // caller sent. Both copies go through the boundary.
    const res = await call('/api/projects/wakecap', { method: 'PATCH', body: { [LEAK_KEY]: 1 } });
    expect(res.status).toBe(422);
    const text = JSON.stringify(await json(res));
    expect(text).toContain('«redacted:github»');
    expect(text).not.toContain(LEAK_KEY);
  });

  it('a thrown ZodError never reaches onError, so the branch that handled it was dead', async () => {
    // Round 3 flagged the `ZodError` branch of `onError` as unpinned: reverting it to an
    // unredacted `apiError` failed nothing. The reason turned out to be that it was UNREACHABLE.
    // A zod v4 ZodError is not an `instanceof Error` in this runtime, and Hono's `handleError`
    // rethrows anything that is not, so it escapes the app rather than being converted to our
    // 400. The branch is gone; this is the canary that says to put it back.
    const zodError = new ZodError([{ code: 'custom', path: [], message: 'm' }] as never);
    expect(
      zodError instanceof Error,
      'zod now extends Error: restore the ZodError branch in app.ts onError, redacting its issues',
    ).toBe(false);

    app.get('/__zod', async () => {
      throw zodError;
    });
    await expect(app.request(`${BASE}/__zod`)).rejects.toBeInstanceOf(ZodError);
  });
});

describe('the declared exemptions round-trip byte-exact', () => {
  it('applies a saved view identically after a round trip through the API', async () => {
    // `SavedViews.tsx` calls `viewQueryToSearch(v.query)` on the SERVED view, so a redacted query
    // would silently search for something else and persist the tag on the next save. And the use
    // case this protects is the pointed one: searching your own transcripts for a leaked secret.
    const query = { q: 'api_key=abc123def456', ticket: 'SAF-1787', model: 'sk-ant-notarealkey00' };
    const saved = (await json(
      await call('/api/views', { method: 'POST', body: { name: 'leak hunt', query } }),
    )) as { id: string; query: Record<string, string> };
    expect(saved.query).toEqual(query);

    const listed = (await json(await call('/api/views'))) as Array<{
      id: string;
      query: Record<string, string>;
    }>;
    expect(listed.find((v) => v.id === saved.id)?.query).toEqual(query);

    // Re-saving what was served must not drift, which is what a tag in the query would cause.
    const resaved = (await json(
      await call('/api/views', { method: 'POST', body: { name: 'leak hunt 2', query: saved.query } }),
    )) as { query: Record<string, string> };
    expect(resaved.query).toEqual(query);
  });
});
