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

export function redactEvent(e: TimelineEvent): TimelineEvent {
  return { ...e, text: r(e.text), input: redactValue(e.input) };
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
  };
}

/** `description` is transcript-derived free text (the parent session's Agent tool-call input). */
export function redactAgent(a: AgentNode): AgentNode {
  return { ...a, description: redact(a.description) };
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
  };
}
