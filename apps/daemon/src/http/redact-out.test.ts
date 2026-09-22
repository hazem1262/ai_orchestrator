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
import {
  CENSUS,
  CREATE_APP_LOCAL,
  EXPORT_KINDS,
  RAW_API_ERROR_FILES,
  REGISTRAR_FILES,
} from '../../test/route-census.ts';
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
  SECRET_KEY_PATTERNS,
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
  // DERIVED, not hand-listed: one seeded key per alternative in SECRET_KEY. Six of the eleven
  // were unpinned when the seeds were hand-chosen — `token`, `pwd`, `secret`, `private[_-]?key`,
  // `access[_-]?key` and `apikey` could each be deleted with the suite still green.
  byPattern: Object.fromEntries(
    SECRET_KEY_PATTERNS.map((pat) => [pat.sample, seedBare(leaves, `${path}.byPattern.${pat.sample}`)]),
  ),
  // The argv form: the pair is split across ADJACENT ELEMENTS.
  argv: ['--password', seedBare(leaves, `${path}.argv.1`)],
  // Pair form in PascalCase / SCREAMING_CASE, which every non-JS serialiser produces.
  pascalPair: { Name: 'Authorization', Value: seedBare(leaves, `${path}.pascalPair.Value`) },
  screamingPair: { NAME: 'PGPASSWORD', VALUE: seedBare(leaves, `${path}.screamingPair.VALUE`) },
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
      // Task 9 made good on this: `InboxUpsert` has no `dedupeKey` field at all, so a caller has
      // no channel to hand one in. Every key is composed by `inboxDedupeKey` from a closed `kind`
      // enum, a closed scope tag and a percent-encoded id. `dedupeKey is composed, never copied`
      // below pins both halves — who may touch the field, and that the composer is the only
      // source of the value the engine writes.
      dedupeKey: 'composed from kind + scope by inbox/dedupe-key.ts; never copied from free text',
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
      // THE SECOND DECLARED EXEMPTION, alongside `GET /api/projects/:id`, and for the same
      // round-trip reason: `SavedViews.tsx` applies `viewQueryToSearch(v.query)` from the SERVED
      // view, so redacting a saved search for `q: "api_key=abc"` would silently return different
      // results and persist the tag on the next save. It also breaks the use case exactly —
      // searching your own transcripts for a leaked secret is a first-class use of this tool, and
      // it is the one search redaction would destroy. See `redactSavedView`.
      'query.[key]': 'user-authored search string; must round-trip byte-exact (see redactSavedView)',
      'query.[value]': 'user-authored search string; must round-trip byte-exact (see redactSavedView)',
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

describe('the boundary census', () => {
  // Registration never touches `ctx` — only the handlers do, and none run here.
  const stub = {} as DaemonContext;
  const routesOf = (a: { routes: Array<{ method: string; path: string }> }) =>
    [...new Set(a.routes.map((r) => `${r.method} ${r.path}`))].sort();
  // Every point in the option space that changes what gets registered, not one point in it. The
  // census used to omit `webDist`, so `registerStatic`'s route never appeared — while production
  // `createDaemon()` defaults it to `apps/web/dist`, which exists.
  const OPTION_SPACE = [{ webDist: null }, { webDist: '/nonexistent/web-dist' }];
  const served = [
    ...new Set(
      OPTION_SPACE.flatMap((opts) =>
        routesOf(createApp({ ctx: stub, token: 't', port: () => 4317, env: {}, ...opts })),
      ),
    ),
  ].sort();

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
    expect(found.sort()).toEqual([...REGISTRAR_FILES].sort());
  });

  it('builds error bodies only through the one redacting constructor', () => {
    // The same enumeration failure one level down: `routes/hooks.ts` constructed two `apiError`
    // bodies itself, bypassing the boundary the census header claims covers errors, and nothing
    // would have detected a third. A file may call `apiError` directly only if it is listed with
    // the reason — which is always "the message and details are compile-time constants".
    const repo = new URL('../../../../', import.meta.url).pathname;
    const found: string[] = [];
    const walkFiles = (dir: URL): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(e.isDirectory() ? `${e.name}/` : e.name, dir);
        if (e.isDirectory()) walkFiles(child);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
          if (/\bapiError\(/.test(readFileSync(child, 'utf8'))) found.push(child.pathname.slice(repo.length));
        }
      }
    };
    walkFiles(new URL('../../../../apps/daemon/src/', import.meta.url));
    walkFiles(new URL('../../../../packages/api-contract/src/', import.meta.url));
    expect(found.sort()).toEqual(Object.keys(RAW_API_ERROR_FILES).sort());
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

  /**
   * Written against the real world, NOT derived from `SECRET_KEY_PATTERNS` — that is the whole
   * point. Deriving both sides means deleting an alternative also deletes the question, which is
   * exactly how six alternatives sat unpinned. Each name here is matched by exactly one
   * alternative (verified), so deleting any one of them fails this test.
   */
  const SECRET_KEY_CORPUS = [
    'PGPASSWORD', // pass[_-]?(word|wd|phrase)
    'passphrase', // ditto
    'user_pwd', // pwd
    'client_secret', // secret
    'refresh_token', // token
    'x-api-key', // api[_-]?key
    'Authorization', // authorization
    'authHeader', // auth(?!or)
    'credential', // credentials?
    'private_key', // private[_-]?key
    'AWS_ACCESS_KEY_ID', // access[_-]?key
  ];

  it.each(SECRET_KEY_CORPUS)('catches the real-world key name %s', (key) => {
    expect(redactValue({ [key]: 'plainvaluenothingmatches' })).toEqual({ [key]: '«redacted:secret»' });
  });

  it('exercises every alternative the pattern list declares', () => {
    // The derived half: no alternative may sit in the list without a sample that reaches it.
    for (const { source, sample } of SECRET_KEY_PATTERNS) {
      expect(new RegExp(source, 'i').test(sample), `sample "${sample}" does not match "${source}"`).toBe(
        true,
      );
    }
  });

  it.each(SECRET_KEY_PATTERNS.map((p) => [p.source, p.sample] as const))(
    'matches the %s alternative via a key named %s',
    (_source, sample) => {
      // Derived from the pattern list itself, so an alternative cannot be added without a sample
      // and cannot be deleted without failing here.
      expect(redactValue({ [sample]: 'plainvaluenothingmatches' })).toEqual({
        [sample]: '«redacted:secret»',
      });
    },
  );

  it('covers the separator forms of the password keyword', () => {
    for (const k of ['pass_word', 'pass-word', 'pass_phrase', 'passphrase', 'PASSWD']) {
      expect(redactValue({ [k]: 'hunter2' })).toEqual({ [k]: '«redacted:secret»' });
    }
  });

  it('redacts the pair form case-insensitively, and an argv flag/value pair', () => {
    expect(redactValue({ Name: 'Authorization', Value: 'Bearer abc123xyz789' })).toEqual({
      Name: 'Authorization',
      Value: '«redacted:secret»',
    });
    expect(redactValue({ NAME: 'PGPASSWORD', VALUE: 'hunter2' })).toEqual({
      NAME: 'PGPASSWORD',
      VALUE: '«redacted:secret»',
    });
    // The argv class: a flag and its value are ADJACENT ELEMENTS, so nothing anchors on either.
    expect(redactValue({ args: ['--password', 'hunter2', '--verbose'] })).toEqual({
      args: ['--password', '«redacted:secret»', '--verbose'],
    });
  });

  it('leaves a value that defines its own JSON form alone', () => {
    // `walk` rebuilds objects via Object.entries/fromEntries, which flattens a Date to `{}`. That
    // now matters: this walker also runs over `ServiceError.details`, which is in-process JS.
    const when = new Date('2026-09-01T09:00:00.000Z');
    expect((redactValue({ when }) as { when: Date }).when).toBeInstanceOf(Date);
    expect(JSON.stringify(redactValue({ when }))).toBe('{"when":"2026-09-01T09:00:00.000Z"}');
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
  // `InboxItem.dedupeKey` is allowlisted as structural on the strength of how it is built. Task 9
  // introduced the producer, so the promise is no longer hypothetical; this keeps it honest.
  // Three properties are pinned, because none of them is sufficient alone:
  //   1. WHO may mention the field at all (below) — a new producer has to come and argue here.
  //   2. HOW the two inbox files use the name (`the inbox files only compose and look up keys`) —
  //      a source scan, so it catches a caller key assigned in a way TypeScript is happy with.
  //      Note its limit: a smuggle hidden *inside* `inboxDedupeKey` need not contain the string
  //      `dedupeKey` at all, and this test cannot see it.
  //   3. THAT NO CALLER VALUE REACHES THE KEY — `cannot be steered by any caller-supplied value`
  //      in `inbox/engine.test.ts`, which seeds every caller-controlled field with a sentinel and
  //      asserts the composed key. That one is behavioural and no refactor can weaken it; the two
  //      source-level tests here are the early-warning layer above it.
  it('has no producer outside the schema, the repository and the one composer', () => {
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
      'apps/daemon/src/inbox/dedupe-key.ts', // THE composer — the only place a key is built
      'apps/daemon/src/inbox/engine.ts', // writes the composed key onto the row it inserts
      'apps/daemon/src/inbox/rules/status-rules.ts', // compares rows against a composed key; never writes one
      'packages/api-contract/src/routes/inbox.ts', // the wire schema
      'packages/core/src/types/inbox.ts', // the type
    ]);
  });

  it('the inbox files only compose and look up keys', () => {
    /**
     * The allowed *uses* of the name, matched from the `dedupeKey` token to end of line. This is
     * deliberately a shape test rather than an exact-line test: renaming the surrounding locals or
     * rewrapping the call must not fail it, but assigning a key from anything other than the
     * composer must.
     */
    const ALLOWED: Array<[form: RegExp, why: string]> = [
      [/^dedupeKey = inboxDedupeKey\(/, 'composing into a local'],
      [/^dedupeKey: inboxDedupeKey\(/, 'composing straight onto the row'],
      [/^dedupeKey,$/, 'the row field, shorthand from a same-named local'],
      [/^dedupeKey: [A-Za-z_$][\w$]*,$/, 'the row field, from a plain local of any name'],
      [/^dedupeKey\)/, 'passing a key to a repo lookup'],
      [/^dedupeKey'\]/, "the composer's return type, `InboxItem['dedupeKey']`"],
      [
        /^dedupeKey === [A-Za-z_$][\w$]*\)/,
        'comparing a row against a composed local (a lookup, not a write)',
      ],
    ];
    for (const file of ['../inbox/engine.ts', '../inbox/dedupe-key.ts', '../inbox/rules/status-rules.ts']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of code.matchAll(/\bdedupeKey\b.*$/gm)) {
        expect(
          ALLOWED.some(([form]) => form.test(m[0])),
          `${file}: \`${m[0].trim()}\` is not an allowed use of dedupeKey. The key must come from ` +
            `inboxDedupeKey() and nowhere else — a caller-supplied value here would let two ` +
            `sessions share one inbox row and silently suppress each other. Allowed forms: ` +
            ALLOWED.map(([form, why]) => `${form.source} (${why})`).join('; '),
        ).toBe(true);
      }
    }
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
    name: 'redactedApiError',
    run: () => {
      // The single constructor for an error body: both the message and the details go through.
      expect(
        boundary.redactedApiError('cwd_missing', 'directory /x/PGPASSWORD=hunter2 gone', {
          cwd: '/x/PGPASSWORD=hunter2',
          issues: [{ code: 'unrecognized_keys', keys: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'] }],
        }),
      ).toEqual({
        error: {
          code: 'cwd_missing',
          message: 'directory /x/PGPASSWORD=«redacted:secret» gone',
          details: {
            cwd: '/x/PGPASSWORD=«redacted:secret»',
            issues: [{ code: 'unrecognized_keys', keys: ['«redacted:github»'] }],
          },
        },
      });
      // `details` omitted stays omitted, rather than becoming an explicit undefined.
      expect(boundary.redactedApiError('nope', 'gone')).toEqual({
        error: { code: 'nope', message: 'gone' },
      });
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
