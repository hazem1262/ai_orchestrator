import type { SupervisorIntent, SupervisorRule } from '@orc/api-contract';
import { checkDenied, type DenyVerdict } from '@orc/core';
import type { PendingQuestion } from './question.ts';

export interface IntentRule {
  intent: SupervisorIntent;
  pattern: RegExp;
  answer: string;
  /** Extra condition on the whole question; used so "retry" only fires for transient errors. */
  requires?: RegExp;
}

export const BUILTIN_INTENTS: readonly IntentRule[] = [
  {
    intent: 'proceed_plan',
    pattern: /\b(proceed|go ahead|continue|start)\b[^?.]{0,40}\bwith\s+(the\s+)?(approved\s+)?plan\b/i,
    answer: 'Yes, proceed with the approved plan.',
  },
  {
    intent: 'run_tests',
    pattern: /\b(run|re-?run|execute)\b[^?.]{0,30}\btests?\b/i,
    answer: 'Yes, run the tests.',
  },
  {
    intent: 'retry_transient',
    pattern: /\b(retry|try again)\b/i,
    requires:
      /\b(429|503|529|overloaded|rate.?limit(ed)?|timed out|timeout|econnreset|etimedout|temporarily unavailable|api error)\b/i,
    answer: 'Yes, retry.',
  },
  {
    intent: 'continue',
    pattern:
      /(^|\b)(should i|shall i|do you want me to|want me to|ok to|may i)\s+(continue|proceed|keep going|go ahead)\b|^\s*(continue|proceed|keep going)\s*\??\s*$|\b(continue|proceed)\?\s*$/i,
    answer: 'Yes, continue.',
  },
];

/** Regex sources (case-insensitive). Anything matching escalates, whatever the classifier says. */
export const SUPERVISOR_DENY_PATTERNS: string[] = [
  String.raw`\b(prod|production|live\s+environment)\b`,
  String.raw`\bdeploy(s|ed|ing|ment)?\b`,
  String.raw`\brelease\b`,
  String.raw`\bmerge\b`,
  String.raw`\bgit\s+push\s+(-f|--force)`,
  String.raw`\bforce[- ]push\b`,
  String.raw`\bgit\s+reset\s+--hard\b`,
  String.raw`\brm\s+-rf\b`,
  String.raw`\bdrop\s+(table|database)\b`,
  String.raw`\btruncate\s+table\b`,
  String.raw`\bmigrat(e|ion)\b`,
  String.raw`\bterraform\b|\bkubectl\b|\bhelm\b`,
  String.raw`\b(credential|password|secret|api[_-]?key|token)s?\b`,
  String.raw`\bdelete\b[^?.]{0,20}\b(branch|data|rows|records|users)\b`,
  String.raw`\bcharge|\bpayment\b|\bbilling\b`,
];

export interface RuleVerdict {
  intent: SupervisorIntent | null;
  answer: string | null;
  matchedBy: 'builtin' | 'user' | null;
  denied: boolean;
  denyReason: string | null;
}

export function compileUserPattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

const noMatch: RuleVerdict = { intent: null, answer: null, matchedBy: null, denied: false, denyReason: null };
const denyVerdict = (reason: string): RuleVerdict => ({
  intent: null,
  answer: null,
  matchedBy: null,
  denied: true,
  denyReason: reason,
});

export function applyRules(
  q: PendingQuestion,
  opts: { rules: readonly SupervisorRule[]; deny: (text: string) => DenyVerdict },
): RuleVerdict {
  const shared = opts.deny(q.text);
  if (shared.denied) return denyVerdict(`deny-list: ${shared.reason ?? 'matched'}`);
  const own = checkDenied(q.text, SUPERVISOR_DENY_PATTERNS);
  if (own.denied) return denyVerdict(`supervisor deny-list: ${own.reason ?? 'matched'}`);
  for (const r of opts.rules) {
    if (r.kind !== 'deny') continue;
    const re = compileUserPattern(r.pattern);
    if (re?.test(q.text)) return denyVerdict(`rule: ${r.note ?? r.pattern}`);
  }
  for (const r of opts.rules) {
    if (r.kind !== 'allow' || !r.intent || !r.answer) continue;
    const re = compileUserPattern(r.pattern);
    if (re?.test(q.tail))
      return { intent: r.intent, answer: r.answer, matchedBy: 'user', denied: false, denyReason: null };
  }
  for (const b of BUILTIN_INTENTS) {
    if (!b.pattern.test(q.tail)) continue;
    if (b.requires && !b.requires.test(q.text)) continue;
    return { intent: b.intent, answer: b.answer, matchedBy: 'builtin', denied: false, denyReason: null };
  }
  return noMatch;
}

/** Turns a question into a literal regex, so "that was wrong" escalates the same question next time. */
export function feedbackPattern(question: string): string {
  const normalised = question.replace(/\s+/g, ' ').trim().slice(0, 80);
  return normalised.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
}

export function inQuietHours(now: Date, quiet: { start: string; end: string } | null): boolean {
  if (!quiet) return false;
  const mins = (hhmm: string): number => {
    const [h, m] = hhmm.split(':');
    return Number(h) * 60 + Number(m);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = mins(quiet.start);
  const end = mins(quiet.end);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}
