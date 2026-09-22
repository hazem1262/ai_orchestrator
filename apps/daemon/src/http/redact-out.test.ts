import { readdirSync, readFileSync } from 'node:fs';
import type { HttpBindings } from '@hono/node-server';
import {
  AgentNodeSchema,
  InboxItemSchema,
  ProjectSchema,
  PtyInfoSchema,
  SavedViewSchema,
  SessionListItemSchema,
  SessionSchema,
  TimelineEventSchema,
} from '@orc/api-contract';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { DaemonContext } from '../context.ts';
import { createApp, registerAllRoutes } from './app.ts';
import * as boundary from './redact-out.ts';
import {
  redactAgent,
  redactEvent,
  redactInboxItem,
  redactListItem,
  redactProject,
  redactPtyInfo,
  redactSavedView,
  redactSession,
  redactValue,
} from './redact-out.ts';

/**
 * The exhaustive guard for the daemon's single redaction boundary.
 *
 * Phase 1 closed twelve separate raw-value leaks here, each found by a human re-reading the field
 * list. The thirteenth would have been found the same way, which is the problem: a test that names
 * the fields it checks can only ever be as complete as the last person to remember to edit it.
 *
 * So this file names no fields. It walks the zod schema of each shape that crosses the boundary,
 * seeds **every** string-valued leaf with a distinct, secret-shaped sentinel, runs the whole object
 * through the boundary function, and asserts that no sentinel survives anywhere in the serialized
 * output. Three properties make that exhaustive by construction rather than by memory:
 *
 * 1. The schemas are declared `z.ZodType<Session>` (etc.) in `@orc/api-contract`, so TypeScript
 *    already refuses a schema that is missing an interface field. Walking the schema therefore
 *    walks the interface.
 * 2. A leaf is **redacted by default**. A field added tomorrow is seeded automatically and fails
 *    this test unless it is either redacted or explicitly declared structural below, with a reason.
 *    Unsafe-by-omission is impossible; the author is forced to make the call.
 * 3. The populator throws on any zod type it does not recognise, so a field of a new *kind*
 *    (a union, a tuple, a branded string) cannot slip through as "no leaves found".
 *
 * `structural` is the inverse list — keys and timestamps, the values that identify a row rather
 * than describe it. Those are asserted to survive **unchanged**, so the allowlist is load-bearing
 * too: quietly starting to redact a pk would fail here rather than silently break the UI's links.
 */

// ---------------------------------------------------------------------------------------------
// Sentinel population, driven by the zod schema.
// ---------------------------------------------------------------------------------------------

interface ZodDef {
  type: string;
  shape?: Record<string, unknown>;
  innerType?: unknown;
  element?: unknown;
  entries?: Record<string, unknown>;
  valueType?: unknown;
}

const defOf = (schema: unknown): ZodDef => {
  const s = schema as { _zod?: { def?: ZodDef }; def?: ZodDef };
  const d = s?._zod?.def ?? s?.def;
  if (!d || typeof d.type !== 'string') throw new Error('not a zod schema');
  return d;
};

/**
 * A GitHub-PAT-shaped token: `redact()` replaces the whole match, so a surviving sentinel is
 * unmistakable in the output. Unique per leaf (the ordinal prefix) so a failure names the path.
 * Padded to keep at least the 20 trailing characters the pattern requires.
 */
const sentinelFor = (ordinal: number, path: string): string =>
  `ghp_${ordinal}z${path.replace(/[^A-Za-z0-9]/g, '')}`.padEnd(24, 'x');

/**
 * The second sentinel family, and the reason there are two. A `ghp_…` token is caught by
 * `redact()` on its own, so it can only ever prove that a field *reaches* the boundary. A bare
 * sentinel matches no pattern at all: the only thing that can redact it is the key it sits under.
 * Phase 1's leaks were value-shape leaks — a secret split so nothing anchors on it — and a guard
 * built only from self-contained tokens is constitutionally blind to that class.
 */
const bareSentinelFor = (ordinal: number, path: string): string =>
  `bare_${ordinal}z${path.replace(/[^A-Za-z0-9]/g, '')}`;

const ANY_SENTINEL = /(?:ghp_|bare_)[A-Za-z0-9]+/g;

type Leaves = Map<string, string>;

const seed = (leaves: Leaves, path: string): string => {
  const s = sentinelFor(leaves.size, path);
  leaves.set(path, s);
  return s;
};

const seedBare = (leaves: Leaves, path: string): string => {
  const s = bareSentinelFor(leaves.size, path);
  leaves.set(path, s);
  return s;
};

/**
 * `z.unknown()` has no shape to walk, so it gets a fixed nesting that exercises the generic
 * walker. The lower half is the split-shape class: the key carries the whole signal and the value
 * matches no redaction pattern by itself, which is exactly how an MCP tool call records an
 * `Authorization` header or a `PGPASSWORD` env var.
 */
const fillUnknown = (path: string, leaves: Leaves): unknown => ({
  text: seed(leaves, `${path}.text`),
  list: [seed(leaves, `${path}.list.0`)],
  nested: { deep: seed(leaves, `${path}.nested.deep`) },
  env: { PGPASSWORD: seedBare(leaves, `${path}.env.PGPASSWORD`) },
  headers: { Authorization: `Bearer ${seedBare(leaves, `${path}.headers.Authorization`)}` },
  api_key: seedBare(leaves, `${path}.api_key`),
  nestedSecret: { credentials: [seedBare(leaves, `${path}.nestedSecret.credentials.0`)] },
  // The pair form: no KEY here is secret-ish, the signal is the VALUE of `name`/`key`.
  headerList: [{ name: 'Authorization', value: seedBare(leaves, `${path}.headerList.0.value`) }],
  envList: [{ name: 'PGPASSWORD', value: seedBare(leaves, `${path}.envList.0.value`) }],
  pair: { key: 'PGPASSWORD', value: seedBare(leaves, `${path}.pair.value`) },
  // A secret-ish key whose value is an OBJECT — the signal must survive the recursion.
  authObject: { type: 'bearer', value: seedBare(leaves, `${path}.authObject.value`) },
});

function populate(schema: unknown, path: string, leaves: Leaves): unknown {
  const d = defOf(schema);
  switch (d.type) {
    case 'string':
      return seed(leaves, path);
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'enum': {
      const first = Object.values(d.entries ?? {})[0];
      if (first === undefined) throw new Error(`empty enum at "${path}"`);
      return first;
    }
    // Never null/undefined: an unpopulated field carries nothing, so it could not be tested.
    case 'nullable':
    case 'optional':
      return populate(d.innerType, path, leaves);
    case 'array':
      return [populate(d.element, `${path}.0`, leaves)];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d.shape ?? {})) {
        out[k] = populate(v, path === '' ? k : `${path}.${k}`, leaves);
      }
      return out;
    }
    case 'record': {
      // The key of an open record is itself a string that reaches the client.
      const key = seed(leaves, `${path}.[key]`);
      return { [key]: populate(d.valueType, `${path}.[value]`, leaves) };
    }
    case 'unknown':
    case 'any':
      return fillUnknown(path, leaves);
    default:
      throw new Error(
        `the sentinel populator does not understand zod type "${d.type}" at "${path}". Teach it, ` +
          'then decide whether that new field is free text (redact it) or structural (declare it).',
      );
  }
}

// ---------------------------------------------------------------------------------------------
// The boundary, one case per exported redactor.
// ---------------------------------------------------------------------------------------------

interface BoundaryCase {
  name: string;
  schema: { parse(v: unknown): unknown };
  run(value: never): unknown;
  /** leaf path -> why this value is an identifier or a timestamp rather than free text. */
  structural: Record<string, string>;
}

const IDS_AND_CLOCKS = {
  id: 'source-native session id (a UUID); the key the client routes on',
  pk: '`<source>:<id>`, the primary key every other route is addressed by',
  sessionId: 'foreign key to a session row',
  projectId: 'orchestrator-assigned project slug, not transcript text',
  startedAt: 'ISO timestamp',
  lastActivityAt: 'ISO timestamp',
} as const;

const LIVE_STRUCTURAL = {
  'live.since': 'ISO timestamp',
  'live.ptyId': 'app-generated PTY id; the client opens /pty/:ptyId with it',
} as const;

const CASES: BoundaryCase[] = [
  {
    name: 'redactSession',
    schema: SessionSchema,
    run: (s) => redactSession(s),
    structural: {
      id: IDS_AND_CLOCKS.id,
      projectId: IDS_AND_CLOCKS.projectId,
      startedAt: IDS_AND_CLOCKS.startedAt,
      lastActivityAt: IDS_AND_CLOCKS.lastActivityAt,
      'lastTest.ts': 'ISO timestamp',
      ...LIVE_STRUCTURAL,
    },
  },
  {
    name: 'redactListItem',
    schema: SessionListItemSchema,
    run: (i) => redactListItem(i),
    structural: {
      pk: IDS_AND_CLOCKS.pk,
      id: IDS_AND_CLOCKS.id,
      projectId: IDS_AND_CLOCKS.projectId,
      startedAt: IDS_AND_CLOCKS.startedAt,
      lastActivityAt: IDS_AND_CLOCKS.lastActivityAt,
      ...LIVE_STRUCTURAL,
    },
  },
  {
    name: 'redactEvent',
    schema: TimelineEventSchema,
    run: (e) => redactEvent(e),
    structural: {
      sessionId: IDS_AND_CLOCKS.sessionId,
      agentId: 'subagent UUID minted by the transcript',
      uuid: 'record UUID; the cursor the timeline pages on',
      parentUuid: 'record UUID of the parent',
      toolUseId: 'opaque `toolu_…` id minted by the API',
      messageId: 'opaque `msg_…` id, used to dedupe usage',
      ts: 'ISO timestamp',
    },
  },
  {
    name: 'redactAgent',
    schema: AgentNodeSchema,
    run: (a) => redactAgent(a),
    structural: {
      id: 'agentId',
      sessionId: IDS_AND_CLOCKS.sessionId,
      parentId: 'parent agentId',
      toolUseId: 'opaque `toolu_…` id minted by the API',
      startedAt: IDS_AND_CLOCKS.startedAt,
      endedAt: 'ISO timestamp',
    },
  },
  {
    name: 'redactInboxItem',
    schema: InboxItemSchema,
    run: (i) => redactInboxItem(i),
    structural: {
      id: 'inbox row id',
      sessionId: IDS_AND_CLOCKS.sessionId,
      projectId: IDS_AND_CLOCKS.projectId,
      // NOTE: nothing composes this yet — tasks 9-15 own the inbox rules. The claim below is a
      // CONSTRAINT ON THOSE TASKS, re-asserted by `dedupeKey is composed, never copied` below,
      // which fails the moment a producer appears that does not satisfy it.
      dedupeKey: 'composed from kind + session pk by the inbox engine; never copied from free text',
      createdAt: 'ISO timestamp',
      updatedAt: 'ISO timestamp',
      snoozeUntil: 'ISO timestamp',
      // `payload.[key]` is deliberately NOT here: `redactValue` now redacts object keys as well
      // as values. Inbox payload keys are rule-authored and `redact()` is a no-op on them, but
      // `TimelineEvent.input` shares the same walker and ITS keys are raw MCP/Bash argument
      // names, so the channel is closed rather than declared away.
    },
  },
  {
    name: 'redactProject',
    schema: ProjectSchema,
    run: (p) => redactProject(p),
    structural: {
      id: 'project slug; every other route is addressed by it',
      lastActivityAt: IDS_AND_CLOCKS.lastActivityAt,
    },
  },
  {
    name: 'redactPtyInfo',
    schema: PtyInfoSchema,
    run: (i) => redactPtyInfo(i),
    structural: {
      id: 'app-generated PTY id; the client opens /pty/:ptyId with it',
      sessionPk: IDS_AND_CLOCKS.pk,
      startedAt: IDS_AND_CLOCKS.startedAt,
      exitedAt: 'ISO timestamp',
    },
  },
  {
    name: 'redactSavedView',
    schema: SavedViewSchema,
    run: (v) => redactSavedView(v),
    structural: {
      id: 'saved-view row id',
      createdAt: 'ISO timestamp',
      // `query.[key]` is likewise absent: keys go through `redact()` too, which is a no-op on
      // every real filter name (q, projectId, source, …).
    },
  },
];

describe('the redaction boundary is exhaustive', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      const leaves: Leaves = new Map();
      const input = populate(c.schema, '', leaves);
      const output = c.run(input as never);
      const json = JSON.stringify(output);

      it('seeds a fully-populated value that is still valid for its schema', () => {
        expect(leaves.size).toBeGreaterThan(0);
        expect(() => c.schema.parse(input)).not.toThrow();
      });

      it('declares no structural path that the schema does not actually have', () => {
        // A typo'd allowlist entry would otherwise excuse nothing while the real path,
        // unlisted, silently fell back to "must be redacted" — or worse, the other way round.
        expect(Object.keys(c.structural).filter((p) => !leaves.has(p))).toEqual([]);
      });

      it('redacts every free-text leaf and leaves every structural leaf intact', () => {
        const leaked: string[] = [];
        const overRedacted: string[] = [];
        for (const [path, s] of leaves) {
          const survived = json.includes(s);
          if (path in c.structural) {
            if (!survived) overRedacted.push(path);
          } else if (survived) {
            leaked.push(path);
          }
        }
        expect({ leaked, overRedacted }).toEqual({ leaked: [], overRedacted: [] });
      });

      it('emits no sentinel anywhere beyond the declared structural ones', () => {
        // Catches a value copied into a field the walker never seeded (an alias, a duplicated
        // summary field), which the per-path check above cannot see.
        const allowed = new Set(
          Object.keys(c.structural)
            .map((p) => leaves.get(p))
            .filter((v): v is string => v !== undefined),
        );
        const found = json.match(ANY_SENTINEL) ?? [];
        expect(found.filter((m) => !allowed.has(m))).toEqual([]);
      });
    });
  }
});

describe('live.waitingFor', () => {
  // Free text lifted verbatim out of Claude Code's own registry file (real entries carry it), and
  // the field that leaked in phase 1. Covered on its own as well as by the walk above, because the
  // walk proves "a whole-string token disappears" while this proves a secret *embedded* in a
  // sentence does too — the shape the registry actually produces.
  const live = {
    pid: 4242,
    status: 'waiting' as const,
    waitingFor: 'run with PGPASSWORD=hunter2 to continue',
    since: '2026-09-01T09:00:00.000Z',
    ownership: 'observed' as const,
    ptyId: null,
    stage: null,
    currentTool: null,
    backgroundJobs: 0,
    runningSubagents: 0,
    contextFill: null,
  };
  const expected = 'run with PGPASSWORD=«redacted:secret» to continue';

  it('is redacted on a Session', () => {
    const s = SessionSchema.parse(populate(SessionSchema, '', new Map()));
    expect(redactSession({ ...s, live }).live?.waitingFor).toBe(expected);
  });

  it('is redacted on a SessionListItem', () => {
    const i = SessionListItemSchema.parse(populate(SessionListItemSchema, '', new Map()));
    expect(redactListItem({ ...i, live }).live?.waitingFor).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------------
// The meta-gap: the guard above is exhaustive WITHIN a shape, but `CASES` is a hand-written list.
// Nothing above notices a sixth shape that crosses the boundary with no redactor at all — which
// is how `Project.pathPrefixes`, `PtyInfo.args` and `SavedView.query` were served raw for a whole
// phase. "Someone must remember", moved up one level, is still the failure mode that cost us
// thirteen fields. These three tests chain route -> redactor -> case so it cannot recur:
//
//   1. the routes the daemon actually registers must all be declared here (a new route fails);
//   2. every redactor a declaration names must really be exported by `redact-out.ts`;
//   3. every SHAPE redactor `redact-out.ts` exports must appear in `CASES` (a new shape fails).
//
// The census can only see SUCCESS bodies. Error bodies are a second response channel, and one of
// them (`cwd_missing`) was serving `startCwd` raw on a route this table calls guarded. That is
// handled where it belongs — `app.ts`'s `onError` walks every `ServiceError` message and details
// through `redactValue` — rather than by enumerating each route's possible errors here.
// `app.test.ts > route-level redaction` is the third link: it hits the real routes, success and
// error alike, with sentinels seeded into every shape below.
// ---------------------------------------------------------------------------------------------

interface CensusEntry {
  /** The `redact-out.ts` export that guards this response, or null when there is no free text. */
  guardedBy: string | null;
  reason: string;
}

const CENSUS: Record<string, CensusEntry> = {
  'ALL /api/*': { guardedBy: null, reason: 'the auth middleware and the 404 catch-all; apiError only' },
  'GET /api/health': { guardedBy: null, reason: 'version, uptime and counts' },
  'GET /bootstrap.js': {
    guardedBy: null,
    reason: 'deliberately serves the loopback token itself to a same-origin local request',
  },
  'GET /api/sessions': { guardedBy: 'redactListItem', reason: '' },
  'GET /api/sessions/:source/:id': { guardedBy: 'redactSession', reason: '' },
  'GET /api/sessions/:source/:id/events': { guardedBy: 'redactEvent', reason: '' },
  'GET /api/sessions/:source/:id/agents': { guardedBy: 'redactAgent', reason: '' },
  'POST /api/sessions/:source/:id/resume': { guardedBy: 'redactResume', reason: '' },
  'POST /api/sessions/:source/:id/pin': { guardedBy: null, reason: '{ pinned: boolean }' },
  'POST /api/sessions/:source/:id/label': { guardedBy: 'redactLabels', reason: '' },
  'GET /api/labels': { guardedBy: 'redactLabels', reason: '' },
  'GET /api/projects': { guardedBy: 'redactProject', reason: '' },
  'GET /api/projects/:id': {
    guardedBy: null,
    reason:
      'the settings editor round-trip: the client GETs this, edits a field and PATCHes the whole ' +
      'object back, so a tag written here would land in the user’s own config.json as the new ' +
      'pathPrefixes and unbind the project. User-authored config, not transcript-derived.',
  },
  'PATCH /api/projects/:id': { guardedBy: null, reason: 'echoes the config the client just sent; see above' },
  'GET /api/pty': { guardedBy: 'redactPtyInfo', reason: '' },
  'DELETE /api/pty/:ptyId': {
    guardedBy: 'redactPtyInfo',
    reason: 'the 409 confirmation summary embeds the same argv and cwd, built from the redacted view',
  },
  'GET /api/views': { guardedBy: 'redactSavedView', reason: '' },
  'POST /api/views': { guardedBy: 'redactSavedView', reason: '' },
  'DELETE /api/views/:id': { guardedBy: null, reason: '{ ok: true }' },
};

/**
 * Every export of `redact-out.ts`, split by what it is. `shape` members must each have a `CASES`
 * entry and are then walked exhaustively. `primitive` members have no schema to walk — a bare
 * `string[]`, a two-branch union, a raw value — so each one has a focused test in this file
 * instead; `every primitive redactor has a focused test` below pins that.
 */
const EXPORT_KINDS: Record<string, 'shape' | 'primitive'> = {
  redactSession: 'shape',
  redactListItem: 'shape',
  redactEvent: 'shape',
  redactAgent: 'shape',
  redactInboxItem: 'shape',
  redactProject: 'shape',
  redactPtyInfo: 'shape',
  redactSavedView: 'shape',
  redactResume: 'primitive',
  redactLabels: 'primitive',
  redactValue: 'primitive',
  redactSnippet: 'primitive',
};

/**
 * The only route `createApp` registers outside `registerAllRoutes`. (`ALL /api/*` appears on both
 * sides and dedupes to one key: the auth middleware in `createApp`, the 404 catch-all in
 * `registerAllRoutes`.) Anything else that shows up in `createApp` but not in `registerAllRoutes`
 * has been routed around the single registration path, and fails the test below.
 */
const CREATE_APP_LOCAL = ['GET /bootstrap.js'];

describe('the boundary census', () => {
  // Registration never touches `ctx` — only the handlers do, and none run here.
  const stub = {} as DaemonContext;
  const routesOf = (a: { routes: Array<{ method: string; path: string }> }) =>
    [...new Set(a.routes.map((r) => `${r.method} ${r.path}`))].sort();
  const served = routesOf(createApp({ ctx: stub, token: 't', port: () => 4317, env: {} }));

  it('declares every route the daemon actually registers, and no route it does not', () => {
    expect(served).toEqual(Object.keys(CENSUS).sort());
  });

  it('registers HTTP routes only in files this census knows about', () => {
    // The structural half of the same guarantee. Asserting `createApp` and `registerAllRoutes`
    // agree does NOT catch a `registerExtra` hook — the census calls `createApp` without it, so
    // both sides stay equally blind, which is exactly how an unredacted `/api/brand-new` reached
    // the live daemon with the suite green. What does catch it: such a hook's body has to call
    // `app.get(...)` SOMEWHERE, and that somewhere must be listed here. Task 16's
    // `registerPhase2Routes` will have to add its file to this list, which is the moment to add
    // its routes to CENSUS as well.
    const REGISTRARS = [
      'apps/daemon/src/http/app.ts',
      'apps/daemon/src/http/routes/health.ts',
      'apps/daemon/src/http/routes/hooks.ts',
      'apps/daemon/src/http/routes/live.ts',
      'apps/daemon/src/http/routes/projects.ts',
      'apps/daemon/src/http/routes/pty.ts',
      'apps/daemon/src/http/routes/sessions.ts',
      'apps/daemon/src/http/routes/views.ts',
      'apps/daemon/src/http/static.ts',
    ];
    // `.<method>(` with a string-literal first argument starting `/` or `*`: a Hono route
    // registration, and essentially nothing else.
    const REGISTRATION = /\.(?:get|post|put|patch|delete|all|use|route|mount|on)\(\s*['"`][/*]/;
    const repo = new URL('../../../../', import.meta.url).pathname;
    const found: string[] = [];
    const walk = (dir: URL): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(e.isDirectory() ? `${e.name}/` : e.name, dir);
        if (e.isDirectory()) walk(child);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
          if (REGISTRATION.test(readFileSync(child, 'utf8'))) found.push(child.pathname.slice(repo.length));
        }
      }
    };
    walk(new URL('../../../../apps/daemon/src/', import.meta.url));
    expect(found.sort()).toEqual([...REGISTRARS].sort());
  });

  it('registers every API route through the one path the census can see', () => {
    // `createApp` taking a `registerExtra` hook was demonstrated to put an unredacted route into
    // the live daemon with the whole suite green, because the census calls `createApp` without
    // it. Asserting the two agree means a route can only reach the daemon through
    // `registerAllRoutes`, which is the function this file calls directly.
    const viaSinglePath = new Hono<{ Bindings: HttpBindings }>();
    registerAllRoutes(viaSinglePath, stub);
    expect(routesOf(viaSinglePath)).toEqual(served.filter((r) => !CREATE_APP_LOCAL.includes(r)));
  });

  it('names only redactors that `redact-out.ts` really exports', () => {
    const exported = new Set(Object.keys(boundary));
    const named = Object.values(CENSUS)
      .map((e) => e.guardedBy)
      .filter((n): n is string => n !== null);
    expect([...new Set(named)].filter((n) => !exported.has(n))).toEqual([]);
  });

  it('gives every unguarded route a written reason', () => {
    const missing = Object.entries(CENSUS)
      .filter(([, e]) => e.guardedBy === null && e.reason.trim() === '')
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });

  it('every primitive redactor has a focused test that fails if it stops redacting', () => {
    // The schema walk cannot reach these, so without this list a neutered `redactLabels` passes
    // every other test in the file — verified by neutering it.
    const covered = new Set(PRIMITIVE_TESTS.map((t) => t.name));
    const primitives = Object.entries(EXPORT_KINDS)
      .filter(([, kind]) => kind === 'primitive')
      .map(([name]) => name);
    expect(primitives.filter((n) => !covered.has(n))).toEqual([]);
  });

  it('classifies every export, and covers every shape redactor with a CASES entry', () => {
    expect(Object.keys(boundary).sort()).toEqual(Object.keys(EXPORT_KINDS).sort());
    const guarded = new Set(CASES.map((c) => c.name));
    const shapes = Object.entries(EXPORT_KINDS)
      .filter(([, kind]) => kind === 'shape')
      .map(([name]) => name);
    expect(shapes.filter((n) => !guarded.has(n))).toEqual([]);
  });
});

describe('redactValue is key-aware', () => {
  // The bug class the schema walk alone cannot see: `redact()` needs KEYWORD=VALUE inside one
  // string, and JSON splits the two apart. `TimelineEvent.input` is a raw tool-call argument
  // object, so this is the shape a real MCP call records.
  it('redacts a value whose key names a credential, whatever the value looks like', () => {
    expect(
      redactValue({
        env: { PGPASSWORD: 'hunter2' },
        headers: { Authorization: 'Bearer abc123xyz' },
        api_key: 's3cr3tvalue',
      }),
    ).toEqual({
      env: { PGPASSWORD: '«redacted:secret»' },
      headers: { Authorization: '«redacted:secret»' },
      api_key: '«redacted:secret»',
    });
  });

  it('reaches into arrays and nested objects under such a key', () => {
    expect(redactValue({ credentials: ['a', 'b'] })).toEqual({
      credentials: ['«redacted:secret»', '«redacted:secret»'],
    });
    // The flag is carried DOWN: everything below a secret-ish key is secret, siblings included.
    // `{auth:{type:'bearer', value:'abc'}}` used to lose the signal the moment the value was an
    // object, which is why `credentials.username` is over-redacted here on purpose.
    expect(redactValue({ credentials: { username: 'bob', password: 'x', realm: 'internal' } })).toEqual({
      credentials: {
        username: '«redacted:secret»',
        password: '«redacted:secret»',
        realm: '«redacted:secret»',
      },
    });
    expect(redactValue({ auth: { type: 'bearer', value: 'abc123xyz789' } })).toEqual({
      auth: { type: '«redacted:secret»', value: '«redacted:secret»' },
    });
  });

  it('redacts the {name,value} / {key,value} pair form, where no KEY is secret-ish', () => {
    // How a tool call records HTTP headers, env vars and query parameters. The signal sits in the
    // VALUE of `name`, so the key-based rule alone sees nothing here.
    expect(redactValue({ headers: [{ name: 'Authorization', value: 'Bearer abc123xyz789' }] })).toEqual({
      headers: [{ name: 'Authorization', value: '«redacted:secret»' }],
    });
    expect(redactValue({ env: [{ name: 'PGPASSWORD', value: 'hunter2' }] })).toEqual({
      env: [{ name: 'PGPASSWORD', value: '«redacted:secret»' }],
    });
    expect(redactValue({ key: 'PGPASSWORD', value: 'hunter2' })).toEqual({
      key: 'PGPASSWORD',
      value: '«redacted:secret»',
    });
    // The name itself is kept: which header was set is not the secret, and losing it would make
    // the timeline unreadable.
    expect(redactValue({ name: 'Accept', value: 'application/json' })).toEqual({
      name: 'Accept',
      value: 'application/json',
    });
  });

  it('covers the separator forms of the password keyword', () => {
    for (const k of ['pass_word', 'pass-word', 'pass_phrase', 'passphrase', 'PASSWD']) {
      expect(redactValue({ [k]: 'hunter2' })).toEqual({ [k]: '«redacted:secret»' });
    }
  });

  it('redacts object KEYS as well as values', () => {
    expect(redactValue({ ghp_abcdefghijklmnopqrstuvwxyz0123456789: 1 })).toEqual({
      '«redacted:github»': 1,
    });
    // A no-op on every ordinary argument name, which is why this costs nothing.
    expect(Object.keys(redactValue({ command: 'ls', file_path: '/a' }) as object)).toEqual([
      'command',
      'file_path',
    ]);
  });

  it('leaves `author` alone, and never touches non-strings', () => {
    expect(redactValue({ author: 'Jane Doe', authors: ['Jane'] })).toEqual({
      author: 'Jane Doe',
      authors: ['Jane'],
    });
    expect(redactValue({ input_tokens: 1200, total_token_usage: 500, ok: true })).toEqual({
      input_tokens: 1200,
      total_token_usage: 500,
      ok: true,
    });
  });

  it('still catches the single-string form it always did', () => {
    expect(redactValue({ cmd: 'PGPASSWORD=hunter2 psql' })).toEqual({
      cmd: 'PGPASSWORD=«redacted:secret» psql',
    });
  });
});

describe('dedupeKey is composed, never copied', () => {
  // `InboxItem.dedupeKey` is allowlisted as structural on the strength of how it WILL be built.
  // Nothing builds one yet — tasks 9-15 own the inbox rules — so the allowlist entry currently
  // rests on a promise. This pins the promise: the moment a producer appears, this fails and
  // whoever wrote it has to either satisfy the claim or move `dedupeKey` to the redacted side.
  it('has no producer outside the schema and the repository', () => {
    const roots = [
      new URL('../../../../apps/daemon/src/', import.meta.url),
      new URL('../../../../packages/core/src/', import.meta.url),
      new URL('../../../../packages/api-contract/src/', import.meta.url),
    ];
    const repo = new URL('../../../../', import.meta.url).pathname;
    const hits: string[] = [];
    const walk = (dir: URL): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(e.isDirectory() ? `${e.name}/` : e.name, dir);
        if (e.isDirectory()) {
          walk(child);
        } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
          if (/dedupeKey|dedupe_key/.test(readFileSync(child, 'utf8'))) {
            hits.push(child.pathname.slice(repo.length));
          }
        }
      }
    };
    for (const root of roots) walk(root);
    expect(hits.sort()).toEqual([
      'apps/daemon/src/db/repos/inbox.ts', // reads and writes the column
      'apps/daemon/src/db/schema.ts', // declares the column and its unique index
      'packages/api-contract/src/routes/inbox.ts', // the wire schema
      'packages/core/src/types/inbox.ts', // the type
    ]);
  });
});

/** One entry per `primitive` export; the census asserts this list covers all of them. */
const PRIMITIVE_TESTS: Array<{ name: string; run: () => void }> = [
  {
    name: 'redactResume',
    run: () => {
      // The external-launch branch echoes the argv the daemon just ran.
      expect(
        boundary.redactResume({ launched: 'external', command: 'claude --api-key sk-ant-aaaaaaaaaaaa' }),
      ).toEqual({ launched: 'external', command: 'claude --api-key «redacted:anthropic»' });
      // The pty branch is an id and must survive untouched.
      expect(boundary.redactResume({ ptyId: 'p-1' })).toEqual({ ptyId: 'p-1' });
    },
  },
  {
    name: 'redactLabels',
    run: () => {
      expect(boundary.redactLabels(['release', 'token=abc123'])).toEqual([
        'release',
        'token=«redacted:secret»',
      ]);
    },
  },
  {
    name: 'redactValue',
    run: () => {
      expect(redactValue('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('«redacted:github»');
      expect(redactValue({ password: 'x' })).toEqual({ password: '«redacted:secret»' });
    },
  },
  {
    name: 'redactSnippet',
    run: () => {
      // The phase-1 ordering bug: highlight markers split a secret, so `PGPASSWORD=hunter2` became
      // `⟦PGPASSWORD⟧=hunter2` and the pattern no longer anchored — `SSWORD=hunter2` escaped.
      // Redaction therefore runs on the marker-stripped text.
      expect(boundary.redactSnippet('run ⟦PGPASSWORD⟧=hunter2 now')).toBe(
        'run PGPASSWORD=«redacted:secret» now',
      );
      // No secret: the markers must be preserved for the UI to highlight.
      expect(boundary.redactSnippet('ran ⟦pnpm⟧ test')).toBe('ran ⟦pnpm⟧ test');
    },
  },
];

describe('primitive redactors', () => {
  for (const t of PRIMITIVE_TESTS) it(t.name, t.run);
});
