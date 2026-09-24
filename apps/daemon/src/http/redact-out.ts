import {
  type ApiError,
  apiError,
  type PtyInfo,
  type ResumeResponse,
  type SavedView,
  type SessionListItem,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
} from '@orc/api-contract';
import {
  type AgentNode,
  type InboxItem,
  type LiveState,
  type Project,
  type PrRef,
  redact,
  redactPartialTokens,
  type Session,
  type TimelineEvent,
} from '@orc/core';

const r = (t: string | null): string | null => (t === null ? null : redact(t));

/**
 * Derived rather than written out, so it cannot drift from `redact()`'s own `secret` tag.
 * `redact('secret=x')` is `'secret=«redacted:secret»'`.
 */
const SECRET_TAG = redact('secret=x').slice('secret='.length);

/**
 * Object keys whose string value is a credential *by virtue of the key*, whatever the value looks
 * like.
 *
 * `redact()` works on one string at a time and its patterns need `KEYWORD=VALUE` inside that
 * string to anchor on. JSON splits the two apart, so `{"env":{"PGPASSWORD":"hunter2"}}` and
 * `{"headers":{"Authorization":"Bearer abc123xyz"}}` passed through completely untouched while
 * the very same secrets written as `'PGPASSWORD=hunter2 psql'` were caught. That is the same
 * defect class as phase 1's `SSWORD=hunter2`: a secret split so that no pattern anchors on it.
 * It matters because `TimelineEvent.input` is a raw MCP/Bash tool-call argument object, and the
 * same walker now also serves `InboxItem.payload` and the `usage.updated` snapshot.
 *
 * Deliberately broader than `redact()`'s inline keyword set: with no `=` to anchor on, the key
 * name is the only signal there is. `auth(?!or)` keeps an `author` field out of it, and the
 * separators mirror the `api[_-]?key` alternative so `pass_word` and `pass-word` are covered too.
 *
 * **The over-redaction this causes is real and wider than a single example.** Every one of these
 * is matched and tagged: `tokenCount`, `token_count`, `tokens_used`, `maxTokens`, `oauth_scope`,
 * `authorizationHeaderName`. It is also asymmetric — only STRINGS are replaced, so a
 * `{"password": 123456}` is still served as-is. Both are accepted: a cosmetic loss against a
 * served credential, and a number is not a shape a credential normally takes. **`usage.updated`
 * is the one wire shape whose entire subject is token counts**; `p2-daemon.test.ts` pins that its
 * numeric counts reach `/ws` intact. If its snapshot turns out to carry string-valued `*token*` fields, it needs its own redactor rather
 * than the generic walker.
 *
 * Exported as `{ source, sample }` PAIRS, not as one regex literal, so the guard can derive a
 * seeded key from every alternative automatically — an alternative cannot be added without a
 * sample, because the type requires both. Six were unpinned when this was a single literal:
 * `token`, `pwd`, `secret`, `private[_-]?key`, `access[_-]?key` and `apikey` could each be
 * deleted with the whole suite green, because the guard seeded eight hand-chosen keys.
 *
 * Derivation alone does NOT fix that, and it is worth being explicit about why: deleting an entry
 * deletes its sample and its seed along with it, so the test stops asking the question. The guard
 * that actually bites is `SECRET_KEY_CORPUS` in the test — real-world credential key names,
 * written independently of this list, one per alternative.
 *
 * `apikey` was in this list and was dead: `api[_-]?key` already matches it with the separator
 * absent. It is removed rather than left looking covered.
 */
export const SECRET_KEY_PATTERNS: ReadonlyArray<{ source: string; sample: string }> = [
  { source: 'pass[_-]?(?:word|wd|phrase)', sample: 'pass_phrase' },
  { source: 'pwd', sample: 'PWD_VALUE' },
  { source: 'secret', sample: 'clientSecret' },
  { source: 'token', sample: 'refresh_token' },
  { source: 'api[_-]?key', sample: 'x-api-key' },
  { source: 'authorization', sample: 'Authorization' },
  { source: 'auth(?!or)', sample: 'auth' },
  { source: 'credentials?', sample: 'credential' },
  { source: 'private[_-]?key', sample: 'private_key' },
  { source: 'access[_-]?key', sample: 'accessKey' },
];

const SECRET_KEY = new RegExp(SECRET_KEY_PATTERNS.map((p) => p.source).join('|'), 'i');

/**
 * The other half of the same defect. A tool call just as often records a credential as a
 * `{name, value}` (or `{key, value}`) pair — HTTP headers, env vars, query parameters are all
 * serialised that way — and then NO key in the object is secret-ish: the signal sits in the
 * *value* of `name`. Measured before this rule, all of these passed through untouched:
 *
 * ```
 * {headers:[{name:'Authorization', value:'Bearer abc123xyz789'}]}
 * {env:[{name:'PGPASSWORD', value:'hunter2'}]}
 * {key:'PGPASSWORD', value:'hunter2'}
 * ```
 *
 * Matched case-INSENSITIVELY, like `SECRET_KEY` itself: `{Name, Value}` and `{NAME, VALUE}` are
 * what AWS, .NET and every PascalCase serialiser produce, and they passed clean while the regex
 * beside them was `/i`.
 *
 * **Deliberately not covered** (real, but speculative here, and half-covering them is worse than
 * listing them): `{name, val}`, `{k, v}`, `{header, value}`, OpenAPI's `schema.default`, the
 * sibling-object split `[{name:'X'},{value:S}]`, the tuple form `[['PGPASSWORD', S]]`, and a
 * space-separated `--password hunter2` inside a single already-joined string (that one is a gap
 * in `redact()`'s own pattern, which needs `=` or `:` to anchor — it reaches `redactResume`'s
 * `resumeCommandLine` output, whose argv comes from the user's own `resumeProfile` config).
 */
const PAIR_NAME_KEYS = new Set(['name', 'key']);
const PAIR_VALUE_KEY = 'value';

/**
 * `underSecretKey` is carried DOWN through objects, not dropped at the first one. `{auth:{type:
 * 'bearer', value:'abc123'}}` used to lose the signal the moment the value turned out to be an
 * object, because the recursion handed back to the top-level walker. Everything below a
 * secret-ish key is now treated as secret, which does over-redact a sibling like
 * `credentials.username` — the safe direction, and the one the shape is named for.
 */
function walk(v: unknown, underSecretKey: boolean): unknown {
  if (typeof v === 'string') return underSecretKey ? SECRET_TAG : redact(v);
  if (Array.isArray(v)) {
    // The argv form: `['--password', 'hunter2']`. The pair is split across ADJACENT ELEMENTS, so
    // neither a key nor a `{name,value}` sibling carries the signal — the preceding element does.
    // This is the shape `PtyInfo.args` takes, which is the highest-risk unredacted field here.
    return v.map((x, i) => {
      const prev = v[i - 1];
      const flagged = typeof prev === 'string' && SECRET_KEY.test(prev);
      return walk(x, underSecretKey || flagged);
    });
  }
  if (typeof v === 'object' && v !== null) {
    // Anything that defines its own JSON form defines it: rebuilding a Date through
    // `Object.entries`/`fromEntries` flattens it to `{}`, which matters now that this walker also
    // runs over `ServiceError.details` — in-process JS rather than parsed JSON.
    if (typeof (v as { toJSON?: unknown }).toJSON === 'function') return v;
    const entries = Object.entries(v);
    const pairIsSecret = entries.some(
      ([k, x]) => PAIR_NAME_KEYS.has(k.toLowerCase()) && typeof x === 'string' && SECRET_KEY.test(x),
    );
    return Object.fromEntries(
      entries.map(([k, x]) => {
        const secret =
          underSecretKey || SECRET_KEY.test(k) || (pairIsSecret && k.toLowerCase() === PAIR_VALUE_KEY);
        // Keys reach the client too, and in `TimelineEvent.input` they are raw MCP/Bash argument
        // names rather than a fixed vocabulary, so they are redacted as well. `redact()` is a
        // no-op on every ordinary key name (`command`, `file_path`, even `PGPASSWORD`, which is a
        // secret's NAME and not a secret), so this costs nothing in practice. The one caveat: two
        // keys that both redact to the same tag would collapse into one entry.
        return [redact(k), walk(x, secret)];
      }),
    );
  }
  return v;
}

export function redactValue(v: unknown): unknown {
  return walk(v, false);
}

/**
 * `repo` and `url` are both scraped out of transcript text (a `gh` invocation, a pushed remote),
 * so a URL carrying `user:token@host` credentials reaches us as an ordinary PR reference.
 */
const redactPr = (p: PrRef): PrRef => ({ ...p, repo: redact(p.repo), url: redact(p.url) });

/**
 * The two free-text members of `LiveState`. `waitingFor` is copied verbatim out of Claude Code's
 * own registry file (or a hook payload) and `currentTool` is the transcript's tool name, which can
 * carry a user-configured `mcp__<server>__<name>` segment — the same field `redactEvent` already
 * treats as free text. Shared by `redactSession` and `redactListItem` so the two can never drift.
 */
const redactLive = (l: LiveState | null): LiveState | null =>
  l === null ? null : { ...l, waitingFor: r(l.waitingFor), currentTool: r(l.currentTool) };

/**
 * `tool` can carry a user-configured MCP server segment (`mcp__<server>__<name>`), and `mcpServer`
 * is that same segment extracted — both are free text, not a fixed vocabulary. `model` is likewise
 * copied straight out of the transcript record.
 */
export function redactEvent(e: TimelineEvent): TimelineEvent {
  return {
    ...e,
    text: r(e.text),
    input: redactValue(e.input),
    tool: r(e.tool),
    mcpServer: r(e.mcpServer),
    model: r(e.model),
  };
}

export function redactSession(s: Session): Session {
  return {
    ...s,
    name: r(s.name),
    firstPrompt: r(s.firstPrompt),
    lastPrompt: r(s.lastPrompt),
    awaySummary: r(s.awaySummary),
    recap: r(s.recap),
    lastTest: s.lastTest === null ? null : { ...s.lastTest, command: redact(s.lastTest.command) },
    // Every field below is transcript-derived: a path, a tool argument or an extracted token can
    // be named anything. redact() is a no-op on ordinary values, so a real ticket id, skill name
    // or file path passes through untouched and stays matchable in the UI.
    startCwd: redact(s.startCwd),
    cwds: s.cwds.map((c) => redact(c)),
    mcpServers: s.mcpServers.map((m) => redact(m)),
    skills: s.skills.map((k) => redact(k)),
    filesTouched: s.filesTouched.map((f) => redact(f)),
    tickets: s.tickets.map((t) => redact(t)),
    models: s.models.map((m) => redact(m)),
    permissionMode: r(s.permissionMode),
    // A path built from the session's cwd, so it inherits whatever the cwd contains.
    transcriptPath: r(s.transcriptPath),
    prs: s.prs.map(redactPr),
    live: redactLive(s.live),
  };
}

/**
 * `description` is transcript-derived free text (the parent session's Agent tool-call input), and
 * `agentType` is likewise attacker-influenced in a transcript rather than a fixed enum.
 * `transcriptPath` is a path built from the session's cwd.
 */
export function redactAgent(a: AgentNode): AgentNode {
  return {
    ...a,
    description: redact(a.description),
    agentType: redact(a.agentType),
    transcriptPath: redact(a.transcriptPath),
  };
}

/** Highlight markers can split a secret (e.g. "⟦PGPASSWORD⟧=x"), so redaction runs on the plain text first. */
export function redactSnippet(snippet: string): string {
  const plain = snippet.replaceAll(SNIPPET_OPEN, '').replaceAll(SNIPPET_CLOSE, '');
  const clean = redactPartialTokens(redact(plain));
  return clean !== plain ? clean : redactPartialTokens(snippet);
}

export function redactListItem(i: SessionListItem): SessionListItem {
  return {
    ...i,
    name: r(i.name),
    firstPrompt: r(i.firstPrompt),
    lastPrompt: r(i.lastPrompt),
    recap: r(i.recap),
    snippet: i.snippet === null ? null : redactSnippet(i.snippet),
    tickets: i.tickets.map((t) => redact(t)),
    // User-typed, so nothing stops a label from being a pasted token.
    labels: i.labels.map((l) => redact(l)),
    prs: i.prs.map(redactPr),
    live: redactLive(i.live),
  };
}

/**
 * `reason` is the inbox card's headline and is built from the very text that made the session need
 * attention — a Notification hook's message, an API error string, a failing test command. `payload`
 * is an open `Record<string, unknown>` each rule fills as it likes, so it is walked generically.
 */
export function redactInboxItem(i: InboxItem): InboxItem {
  return {
    ...i,
    reason: redact(i.reason),
    ticket: r(i.ticket),
    payload: redactValue(i.payload) as Record<string, unknown>,
  };
}

/**
 * `pathPrefixes` are literally the cwd prefixes that `Session.startCwd`/`cwds[]` are matched
 * against and are redacted for the same reason; `name` is user-typed. This is the LIST shape,
 * which is display-only. The single-project config echo behind `GET /api/projects/:id` is
 * deliberately NOT redacted — see the census in `redact-out.test.ts` for why.
 */
export function redactProject(p: Project): Project {
  return { ...p, name: redact(p.name), pathPrefixes: p.pathPrefixes.map((x) => redact(x)) };
}

/**
 * A PTY's argv is the highest-risk unredacted field in the daemon: a phase-2 launch route that
 * spawns with a token-bearing flag puts that token straight into `args[]`, and `GET /api/pty`
 * serves it. `cwd` is the same class as `Session.startCwd`.
 */
export function redactPtyInfo(i: PtyInfo): PtyInfo {
  // `args` goes through the WALKER, not a per-element `redact()`: a flag and its value are
  // adjacent elements, so `['--password', 'hunter2']` has no `=` for a pattern to anchor on and
  // element-wise redaction sees two innocent strings.
  return {
    ...i,
    command: redact(i.command),
    args: redactValue(i.args) as string[],
    cwd: redact(i.cwd),
  };
}

/**
 * `name` is user-typed and display-only, so it is redacted.
 *
 * **`query` is deliberately NOT**, and it is the second declared exemption at this boundary, for
 * the same reason as `GET /api/projects/:id`: it round-trips. `SavedViews.tsx` applies
 * `viewQueryToSearch(v.query)` straight from the SERVED view, so a saved search for
 * `q: "api_key=abc"` would be applied as `q: "api_key=«redacted:secret»"`, silently return
 * different results, and persist the tag on the next save. Worse, it breaks the use case
 * exactly: **searching your own transcripts for a leaked secret is a first-class use of this
 * tool**, and it is the one search redaction would destroy. A saved query is a user-authored
 * search string that must survive byte-exact.
 */
export function redactSavedView(v: SavedView): SavedView {
  return { ...v, name: redact(v.name), query: { ...v.query } };
}

/**
 * The external-launch branch echoes the full command line the daemon just ran — the same argv
 * class as `PtyInfo`, and the branch a phase-2 launch route grows flags on. The `ptyId` branch
 * carries only an id.
 */
export function redactResume(r: ResumeResponse): ResumeResponse {
  return 'command' in r ? { ...r, command: redact(r.command) } : r;
}

/**
 * User-typed labels, served bare by `GET /api/labels` and echoed by the label mutation.
 * `redactListItem` already redacts the same strings inside a session row; these are the two
 * places the same values are served on their own.
 */
export function redactLabels(labels: string[]): string[] {
  return labels.map((l) => redact(l));
}

/**
 * The single constructor for an error response body.
 *
 * Error bodies are a response channel like any other and were an unmodelled one until fix round 2:
 * `cwd_missing` served `Session.startCwd` raw in both its message and its `details`. `app.ts`'s
 * `onError` routes every thrown error through here — but a route that builds an `apiError` itself
 * bypasses that, which `routes/hooks.ts` did. Having one helper (and a test that lists every file
 * allowed to call `apiError` directly) is what stops a third one appearing.
 */
export function redactedApiError(code: string, message: string, details?: unknown): ApiError {
  return apiError(code, redact(message), details === undefined ? undefined : redactValue(details));
}
