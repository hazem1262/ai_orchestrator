import { redact } from '../redact/redact.ts';
import type { Handoff, Session, TimelineEvent } from '../types/index.ts';

export const EVIDENCE_COMMAND_RE =
  /\b(vitest|jest|pytest|mocha|playwright|dotnet (test|build)|flutter (test|analyze)|go test|cargo test|(pnpm|npm|yarn|bun)( run)? (test|lint|build|typecheck)|tsc|eslint|biome|git (commit|push|merge|rebase|checkout -b)|gh pr)\b/;
const MAX_COMMANDS = 10;
const MAX_FILES = 50;
const VALID_STATUS = new Set(['in_progress', 'ready_for_review', 'blocked', 'done']);

export interface HandoffEvidence {
  evidence: string[];
  files: string[];
  links: string[];
}
export interface HandoffLlmFields {
  status: string;
  summary: string;
  nextSteps: string[];
  blockers: string[];
}

function commandOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const c = (input as Record<string, unknown>).command;
  return typeof c === 'string' ? c : null;
}

export function collectHandoffEvidence(
  s: Pick<Session, 'lastTest' | 'prs' | 'tickets' | 'filesTouched'>,
  events: TimelineEvent[],
  plans: string[] = [],
): HandoffEvidence {
  const evidence: string[] = [];
  const t = s.lastTest;
  if (t) {
    evidence.push(
      `Tests: ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped — \`${redact(t.command)}\` (${t.ts})`,
    );
  }
  for (const p of s.prs) evidence.push(`PR: ${p.url}`);
  const seen = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'tool_call' || e.tool !== 'Bash') continue;
    const cmd = commandOf(e.input);
    if (!cmd || !EVIDENCE_COMMAND_RE.test(cmd)) continue;
    const clean = redact(cmd.replace(/\s+/g, ' ').trim()).slice(0, 200);
    if (seen.has(clean)) continue;
    seen.add(clean);
    evidence.push(`Ran: \`${clean}\``);
    if (seen.size >= MAX_COMMANDS) break;
  }
  return {
    evidence,
    files: [...new Set(s.filesTouched)].slice(0, MAX_FILES),
    links: [...s.prs.map((p) => p.url), ...s.tickets.map((x) => `ticket:${x}`), ...plans],
  };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function parseHandoffJson(text: string): HandoffLlmFields | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let v: unknown;
  try {
    v = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.summary !== 'string') return null;
  return {
    status: typeof o.status === 'string' && VALID_STATUS.has(o.status) ? o.status : 'in_progress',
    summary: o.summary,
    nextSteps: strings(o.nextSteps),
    blockers: strings(o.blockers),
  };
}

const bullets = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- none');

export function handoffToMarkdown(h: Handoff): string {
  return [
    `# Handoff — ${h.status}`,
    `_Session:_ \`${h.sessionId}\` · _Created:_ ${h.createdAt}`,
    '',
    '## Summary',
    h.summary || '_No summary._',
    '',
    '## Evidence',
    bullets(h.evidence),
    '',
    '## Files',
    h.files.length ? h.files.map((f) => `- \`${f}\``).join('\n') : '- none',
    '',
    '## Next steps',
    h.nextSteps.length
      ? h.nextSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '1. Decide the next step with the user.',
    '',
    '## Blockers',
    bullets(h.blockers),
    '',
    '## Links',
    // No trailing newline: the P2 launcher trims the prompt, and the resume prompt must still
    // contain this markdown verbatim.
    bullets(h.links),
  ].join('\n');
}

export function buildResumePrompt(h: Handoff): string {
  return [
    'You are continuing work that an earlier session started. Read the handoff below.',
    'First check the current state of the listed files and branches (things may have changed),',
    'then continue with the next steps. Ask me before doing anything the blockers say is unresolved.',
    '',
    handoffToMarkdown(h),
  ].join('\n');
}
