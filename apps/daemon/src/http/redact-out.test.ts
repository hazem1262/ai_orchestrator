import {
  AgentNodeSchema,
  InboxItemSchema,
  SessionListItemSchema,
  SessionSchema,
  TimelineEventSchema,
} from '@orc/api-contract';
import { describe, expect, it } from 'vitest';
import { redactAgent, redactEvent, redactInboxItem, redactListItem, redactSession } from './redact-out.ts';

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

type Leaves = Map<string, string>;

const seed = (leaves: Leaves, path: string): string => {
  const s = sentinelFor(leaves.size, path);
  leaves.set(path, s);
  return s;
};

/** `z.unknown()` has no shape to walk, so it gets a fixed nesting that exercises the generic walker. */
const fillUnknown = (path: string, leaves: Leaves): unknown => ({
  text: seed(leaves, `${path}.text`),
  list: [seed(leaves, `${path}.list.0`)],
  nested: { deep: seed(leaves, `${path}.nested.deep`) },
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
      dedupeKey: 'composed from kind + session pk; the unique index is on this literal string',
      createdAt: 'ISO timestamp',
      updatedAt: 'ISO timestamp',
      snoozeUntil: 'ISO timestamp',
      // redactValue walks values, not keys. Payload keys are written by the inbox rules
      // themselves (`sessionPk`, `message`, …), never copied from a transcript.
      'payload.[key]': 'rule-authored payload key, not transcript text',
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
        const found = json.match(/ghp_[A-Za-z0-9]+/g) ?? [];
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
