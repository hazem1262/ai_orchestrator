import {
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
 * served credential, and a number is not a shape a credential normally takes. **Task 16 should
 * note that `usage.updated` is the one wire shape whose entire subject is token counts**; if its
 * snapshot turns out to carry string-valued `*token*` fields, it needs its own redactor rather
 * than the generic walker.
 */
const SECRET_KEY =
  /pass[_-]?(?:word|wd|phrase)|pwd|secret|token|api[_-]?key|apikey|authorization|auth(?!or)|credentials?|private[_-]?key|access[_-]?key/i;

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
  if (Array.isArray(v)) return v.map((x) => walk(x, underSecretKey));
  if (typeof v === 'object' && v !== null) {
    const entries = Object.entries(v);
    const pairIsSecret = entries.some(
      ([k, x]) => PAIR_NAME_KEYS.has(k) && typeof x === 'string' && SECRET_KEY.test(x),
    );
    return Object.fromEntries(
      entries.map(([k, x]) => {
        const secret = underSecretKey || SECRET_KEY.test(k) || (pairIsSecret && k === PAIR_VALUE_KEY);
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
  const clean = redact(plain);
  return clean === plain ? snippet : clean;
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
  return { ...i, command: redact(i.command), args: i.args.map((a) => redact(a)), cwd: redact(i.cwd) };
}

/** `name` is user-typed and `query` is a saved filter — whatever the user last searched for. */
export function redactSavedView(v: SavedView): SavedView {
  return { ...v, name: redact(v.name), query: redactValue(v.query) as Record<string, string> };
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
