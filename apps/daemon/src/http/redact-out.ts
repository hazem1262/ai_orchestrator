import { type SessionListItem, SNIPPET_CLOSE, SNIPPET_OPEN } from '@orc/api-contract';
import { type AgentNode, redact, type Session, type TimelineEvent } from '@orc/core';

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
 * `tool` can carry a user-configured MCP server segment (`mcp__<server>__<name>`), and `mcpServer`
 * is that same segment extracted — both are free text, not a fixed vocabulary.
 */
export function redactEvent(e: TimelineEvent): TimelineEvent {
  return { ...e, text: r(e.text), input: redactValue(e.input), tool: r(e.tool), mcpServer: r(e.mcpServer) };
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
    // waitingFor is copied verbatim out of Claude Code's own live-session file, which we do not control.
    live: s.live === null ? null : { ...s.live, waitingFor: r(s.live.waitingFor) },
  };
}

/**
 * `description` is transcript-derived free text (the parent session's Agent tool-call input), and
 * `agentType` is likewise attacker-influenced in a transcript rather than a fixed enum.
 */
export function redactAgent(a: AgentNode): AgentNode {
  return { ...a, description: redact(a.description), agentType: redact(a.agentType) };
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
    live: i.live === null ? null : { ...i.live, waitingFor: r(i.live.waitingFor) },
  };
}
