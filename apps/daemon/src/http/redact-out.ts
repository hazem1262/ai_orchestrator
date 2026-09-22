import { type SessionListItem, SNIPPET_CLOSE, SNIPPET_OPEN } from '@orc/api-contract';
import {
  type AgentNode,
  type InboxItem,
  type LiveState,
  type PrRef,
  redact,
  type Session,
  type TimelineEvent,
} from '@orc/core';

const r = (t: string | null): string | null => (t === null ? null : redact(t));

export function redactValue(v: unknown): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x)]));
  }
  return v;
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
