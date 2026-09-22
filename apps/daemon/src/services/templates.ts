import type { Source } from '@orc/core';

export type TemplateVar = 'ticket' | 'ticketUrl' | 'prUrl' | 'file' | 'check';
export interface Template {
  id: string;
  kind: 'workflow' | 'preset';
  label: string;
  prompt: string;
  vars: TemplateVar[];
  defaultSource: Source;
  projectIds: string[] | 'all';
}
export interface TemplateRegistry {
  list(projectId?: string): Template[];
  render(id: string, vars: Record<string, string>): string;
}

export class TemplateError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: 'template_not_found' | 'template_var_missing' | 'template_var_invalid',
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

const wf = (id: string, label: string, prompt: string, vars: TemplateVar[]): Template => ({
  id,
  kind: 'workflow',
  label,
  prompt,
  vars,
  defaultSource: 'claude',
  projectIds: 'all',
});
const preset = (id: string, label: string, prompt: string, vars: TemplateVar[]): Template => ({
  id,
  kind: 'preset',
  label,
  prompt,
  vars,
  defaultSource: 'claude',
  projectIds: 'all',
});

export const BUILTIN_TEMPLATES: readonly Template[] = [
  wf('wf-implement-ticket', 'Implement ticket', '/conductor {{ticketUrl}}', ['ticketUrl']),
  wf('wf-investigate', 'Investigate', '/investigate {{ticket}}', ['ticket']),
  wf('wf-backmerge', 'Backmerge', '/backmerge {{prUrl}}', ['prUrl']),
  wf('wf-plan', 'Plan', 'Use superpowers:brainstorming to plan {{ticket}}.', ['ticket']),
  wf('wf-review-pr', 'Review PR', 'review this pr {{prUrl}}', ['prUrl']),
  preset(
    'preset-fix-failing-test',
    'Fix the failing test',
    'Fix the failing test in {{file}}. Run it first to see the failure, find the root cause, fix the code (change the test only if the test itself is wrong), and re-run until it passes.',
    ['file'],
  ),
  preset(
    'preset-add-missing-test',
    'Add the missing test',
    'Add the missing test for {{file}}. Follow the existing test conventions in this repo, cover the main behaviour and the edge cases, and run the tests.',
    ['file'],
  ),
  preset(
    'preset-simplify',
    'Simplify this function/file',
    'Simplify {{file}} without changing its behaviour. Keep the public API, remove duplication and dead code, and run the tests before and after.',
    ['file'],
  ),
  preset(
    'preset-address-review',
    'Address PR review comments',
    'Address the review comments on {{prUrl}}. Read every unresolved comment with `gh`, fix each one, run the tests, and summarise what changed for each comment.',
    ['prUrl'],
  ),
  preset(
    'preset-fix-ci',
    'Fix CI failure',
    'Fix the CI failure "{{check}}" on {{prUrl}}. Read the failing logs with `gh pr checks` and `gh run view --log-failed`, reproduce it locally, fix it, and re-run the check.',
    ['prUrl', 'check'],
  ),
];

/** `{{ticketUrl}}` falls back to `{{ticket}}`, so "Implement ticket" works with just `SAF-1787`. */
const ALIASES: Partial<Record<TemplateVar, TemplateVar>> = { ticketUrl: 'ticket' };

/**
 * A rendered prompt is typed into a terminal, so a var value must never carry C0/DEL/C1 controls
 * (C1 includes CSI U+009B), the U+2028/U+2029 line separators, or bidi controls that reorder text.
 */
const isForbiddenCode = (c: number): boolean =>
  c <= 0x1f ||
  (c >= 0x7f && c <= 0x9f) ||
  c === 0x200e ||
  c === 0x200f ||
  (c >= 0x2028 && c <= 0x202e) ||
  (c >= 0x2066 && c <= 0x2069);
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (isForbiddenCode(s.charCodeAt(i))) return true;
  return false;
};

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Every `{{name}}` must be a declared var; `{{ticket}}` is also allowed when `ticketUrl` is declared. */
const assertPlaceholdersDeclared = (t: Template): void => {
  const allowed = new Set<string>(t.vars);
  if (allowed.has('ticketUrl')) allowed.add('ticket');
  for (const [, name] of t.prompt.matchAll(PLACEHOLDER)) {
    if (!name || !allowed.has(name)) {
      throw new Error(`template ${t.id} uses undeclared placeholder {{${name}}}`);
    }
  }
};

export function createTemplateRegistry(opts: { extra?: Template[] } = {}): TemplateRegistry {
  const all: Template[] = [...BUILTIN_TEMPLATES];
  const ids = new Set(all.map((t) => t.id));
  for (const t of all) assertPlaceholdersDeclared(t);
  for (const t of opts.extra ?? []) {
    if (ids.has(t.id)) throw new Error(`duplicate template id: ${t.id}`);
    assertPlaceholdersDeclared(t);
    ids.add(t.id);
    all.push(t);
  }
  return {
    list(projectId) {
      return all.filter(
        (t) => t.projectIds === 'all' || projectId === undefined || t.projectIds.includes(projectId),
      );
    },
    render(id, vars) {
      const t = all.find((x) => x.id === id);
      if (!t) throw new TemplateError(404, 'template_not_found', `template ${id} not found`);
      const read = (name: string): string => {
        const raw = Object.hasOwn(vars, name) ? vars[name] : undefined;
        if (typeof raw !== 'string') return '';
        if (hasControlChar(raw)) {
          throw new TemplateError(
            400,
            'template_var_invalid',
            `template variable ${name} contains a control character`,
          );
        }
        return raw.trim();
      };
      const value = (name: string): string => {
        const direct = read(name);
        if (direct) return direct;
        const alias = ALIASES[name as TemplateVar];
        return alias ? read(alias) : '';
      };
      const values = new Map(t.vars.map((v) => [v, value(v)]));
      const missing = t.vars.filter((v) => values.get(v) === '');
      if (missing.length) {
        throw new TemplateError(
          400,
          'template_var_missing',
          `missing template variables: ${missing.join(', ')}`,
          missing,
        );
      }
      return t.prompt.replace(
        PLACEHOLDER,
        (_m, name: string) => values.get(name as TemplateVar) ?? value(name),
      );
    },
  };
}

export function composePrompt(rendered: string | null, userPrompt: string): string {
  return [rendered?.trim() ?? '', userPrompt.trim()].filter(Boolean).join('\n\n');
}
