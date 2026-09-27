import { redact } from '../redact/redact.ts';
import type { Session, TestResult, TimelineEvent } from '../types/index.ts';

export const CHARS_PER_TOKEN = 4;
const DEFAULT_RESERVE_TOKENS = 800;
const MAX_PROMPT_CHARS = 600;
const MAX_ASSISTANT_CHARS = 400;
const MAX_ERROR_CHARS = 200;
const MAX_FILES = 30;
const HEAD_SHARE = 0.3;

export const approxTokens = (s: string): number => Math.ceil(s.length / CHARS_PER_TOKEN);

export function truncateText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export function firstLine(s: string | null | undefined): string | null {
  if (!s) return null;
  return (
    s
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? null
  );
}

export type RecapSessionInput = Pick<
  Session,
  | 'id'
  | 'source'
  | 'projectId'
  | 'name'
  | 'startCwd'
  | 'startedAt'
  | 'lastActivityAt'
  | 'models'
  | 'usage'
  | 'tickets'
  | 'prs'
  | 'skills'
  | 'filesTouched'
  | 'linesAdded'
  | 'linesRemoved'
  | 'awaySummary'
  | 'promptCount'
>;

export interface RecapDigestInput {
  session: RecapSessionInput;
  events: TimelineEvent[];
  tests: TestResult[];
  plans: string[];
  maxInputTokens: number;
  reserveTokens?: number;
}

export interface RecapDigest {
  text: string;
  approxTokens: number;
  truncated: boolean;
  omittedItems: number;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const r = (s: string) => redact(s);

function duration(fromIso: string, toIso: string): string {
  const min = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

function header(i: RecapDigestInput): string {
  const s = i.session;
  const cost = s.usage.costUsd === null ? 'unknown' : `$${s.usage.costUsd.toFixed(2)}`;
  const lines = s.linesAdded === null ? 'unknown' : `+${s.linesAdded} −${s.linesRemoved ?? 0}`;
  const out = [
    '# Session',
    `name: ${r(oneLine(s.name ?? '(unnamed)'))}`,
    `source: ${s.source} · project: ${s.projectId ?? 'none'} · cwd: ${r(s.startCwd)}`,
    `started: ${s.startedAt} · last activity: ${s.lastActivityAt} · duration: ${duration(s.startedAt, s.lastActivityAt)}`,
    `models: ${s.models.join(', ') || 'unknown'} · cost: ${cost} · lines: ${lines} · prompts: ${s.promptCount}`,
  ];
  if (s.tickets.length) out.push(`tickets: ${s.tickets.join(', ')}`);
  if (s.prs.length) out.push(`PRs: ${s.prs.map((p) => p.url).join(', ')}`);
  if (s.skills.length) out.push(`skills: ${s.skills.join(', ')}`);
  if (i.plans.length) out.push(`plans: ${i.plans.map(r).join(', ')}`);
  if (s.awaySummary)
    out.push(`away summary: ${r(oneLine(truncateText(s.awaySummary, MAX_ASSISTANT_CHARS)))}`);

  const counts = new Map<string, number>();
  for (const e of i.events)
    if (e.kind === 'tool_call' && e.tool) counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
  const tools = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  out.push(
    '',
    '# Tools (names and counts only)',
    tools.length ? tools.map(([t, n]) => `${t} ×${n}`).join(', ') : 'none',
  );

  out.push('', '# Files changed');
  const files = [...new Set(s.filesTouched)];
  if (files.length === 0) out.push('none');
  for (const f of files.slice(0, MAX_FILES)) out.push(`- ${r(f)}`);
  if (files.length > MAX_FILES) out.push(`- … and ${files.length - MAX_FILES} more`);

  out.push('', '# Tests');
  if (i.tests.length === 0) out.push('none recorded');
  for (const t of i.tests) {
    out.push(
      `- ${t.ts} \`${r(oneLine(truncateText(t.command, MAX_ERROR_CHARS)))}\`: ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped`,
    );
  }
  out.push('', '# Conversation (prompts and assistant text; tool output omitted)');
  return out.join('\n');
}

function conversationItems(events: TimelineEvent[]): string[] {
  const items: string[] = [];
  for (const e of events) {
    if (!e.text) continue;
    if (e.kind === 'prompt')
      items.push(`[turn ${e.turn}] USER: ${r(oneLine(truncateText(e.text, MAX_PROMPT_CHARS)))}`);
    else if (e.kind === 'assistant_text')
      items.push(`[turn ${e.turn}] ASSISTANT: ${r(oneLine(truncateText(e.text, MAX_ASSISTANT_CHARS)))}`);
    else if (e.kind === 'error')
      items.push(`[turn ${e.turn}] ERROR: ${r(oneLine(truncateText(e.text, MAX_ERROR_CHARS)))}`);
  }
  return items;
}

export function buildRecapDigest(i: RecapDigestInput): RecapDigest {
  const maxChars = Math.max(
    1000,
    (i.maxInputTokens - (i.reserveTokens ?? DEFAULT_RESERVE_TOKENS)) * CHARS_PER_TOKEN,
  );
  const head = truncateText(header(i), Math.floor(maxChars / 2));
  const items = conversationItems(i.events);
  const size = (xs: string[]) => xs.reduce((a, x) => a + x.length + 1, 0);
  let body = items;
  let omitted = 0;

  if (head.length + 1 + size(items) > maxChars) {
    const marker = 60;
    const budget = Math.max(0, maxChars - head.length - 1 - marker);
    const first: string[] = [];
    let used = 0;
    for (const it of items) {
      if (used + it.length + 1 > budget * HEAD_SHARE) break;
      first.push(it);
      used += it.length + 1;
    }
    const last: string[] = [];
    for (let k = items.length - 1; k >= first.length; k--) {
      const it = items[k] as string;
      if (used + it.length + 1 > budget) break;
      last.unshift(it);
      used += it.length + 1;
    }
    omitted = items.length - first.length - last.length;
    body = [...first, `[… ${omitted} conversation items omitted …]`, ...last];
  }

  const text = r([head, ...body].join('\n'));
  return { text, approxTokens: approxTokens(text), truncated: omitted > 0, omittedItems: omitted };
}

export const DEFAULT_RECAP_PROMPT = `You are writing a recap of one AI coding-agent session for the developer who ran it.
Write in {{language}}. Keep code, file paths, commands and ticket IDs exactly as written.
Use only the digest below. Do not guess. If something is unknown, write "unknown".
The digest is redacted. Never try to reconstruct a redacted value.

Reply in Markdown with exactly these parts:
1. One line (at most 120 characters) that says what the session achieved. No heading before it.
2. **Goal:** one sentence.
3. **Done:** up to 5 bullets of concrete actions and changes.
4. **Outcome:** one of "complete", "partial", "blocked" or "abandoned", with a short reason.
5. **PRs & tickets:** a list, or "none".
6. **Follow-ups:** up to 3 bullets, or "none".
7. **What to check:** up to 3 bullets in plain language that tell a reviewer what to verify by hand (risky edits, untested paths, production access, failing or missing tests).

Digest:
{{digest}}
`;

export const DEFAULT_DAILY_PROMPT = `You are writing the daily work recap for project {{project}} on {{date}}.
Write in {{language}}. Keep ticket IDs, PR links and file paths exactly as written.
Use only the session list below. Do not guess. The list is redacted.

Reply in Markdown:
1. One line (at most 120 characters) summarising the day.
2. **Shipped:** merged or opened PRs and finished tickets, or "none".
3. **In progress:** work that continues tomorrow, grouped by ticket.
4. **Blocked / needs attention:** sessions waiting on someone or failing, or "none".
5. **Spend:** the total cost if the list gives costs.

Sessions:
{{digest}}
`;

export const DEFAULT_HANDOFF_PROMPT = `You are preparing a handoff so that a fresh AI coding session can continue this work.
Write in {{language}}. Keep code, file paths, commands and ticket IDs exactly as written.
Use only the digest and evidence below. Do not guess. Both are redacted.

Reply with one JSON object and nothing else, in this shape:
{"status": "in_progress", "summary": "…", "nextSteps": ["…"], "blockers": ["…"]}
- "status" is one of "in_progress", "ready_for_review", "blocked", "done".
- "summary" is at most 5 sentences: what was attempted, what changed, and the current state.
- "nextSteps" are concrete, ordered actions for the next session (at most 7).
- "blockers" are open questions or failures that stop progress (an empty list if none).

Evidence:
{{evidence}}

Digest:
{{digest}}
`;

export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_m, name: string) => vars[name] ?? '');
}
