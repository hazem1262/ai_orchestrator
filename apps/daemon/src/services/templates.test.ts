import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEMPLATES,
  composePrompt,
  createTemplateRegistry,
  type Template,
  TemplateError,
} from './templates.ts';

const forzaOnly: Template = {
  id: 'forza-only',
  kind: 'preset',
  label: 'Forza',
  prompt: 'x',
  vars: [],
  defaultSource: 'codex',
  projectIds: ['forza'],
};

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw');
};

describe('TemplateRegistry', () => {
  const reg = createTemplateRegistry({ extra: [forzaOnly] });

  it('lists the five workflows and five presets from the spec', () => {
    const builtins = BUILTIN_TEMPLATES.map((t) => `${t.kind}:${t.label}`);
    expect(builtins).toEqual([
      'workflow:Implement ticket',
      'workflow:Investigate',
      'workflow:Backmerge',
      'workflow:Plan',
      'workflow:Review PR',
      'preset:Fix the failing test',
      'preset:Add the missing test',
      'preset:Simplify this function/file',
      'preset:Address PR review comments',
      'preset:Fix CI failure',
    ]);
  });

  it('gives the built-ins the documented ids, prompts, vars, and scope', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toEqual([
      'wf-implement-ticket',
      'wf-investigate',
      'wf-backmerge',
      'wf-plan',
      'wf-review-pr',
      'preset-fix-failing-test',
      'preset-add-missing-test',
      'preset-simplify',
      'preset-address-review',
      'preset-fix-ci',
    ]);
    const byId = new Map(BUILTIN_TEMPLATES.map((t) => [t.id, t]));
    expect(byId.get('wf-implement-ticket')?.prompt).toBe('/conductor {{ticketUrl}}');
    expect(byId.get('wf-investigate')?.prompt).toBe('/investigate {{ticket}}');
    expect(byId.get('wf-backmerge')?.prompt).toBe('/backmerge {{prUrl}}');
    expect(byId.get('wf-plan')?.prompt).toBe('Use superpowers:brainstorming to plan {{ticket}}.');
    expect(byId.get('wf-review-pr')?.prompt).toBe('review this pr {{prUrl}}');
    expect(byId.get('preset-fix-ci')?.vars).toEqual(['prUrl', 'check']);
    for (const t of BUILTIN_TEMPLATES) expect(t.projectIds).toBe('all');
  });

  it('filters by project', () => {
    expect(reg.list('wakecap').some((t) => t.id === 'forza-only')).toBe(false);
    expect(reg.list('forza').some((t) => t.id === 'forza-only')).toBe(true);
    expect(reg.list()).toHaveLength(11);
  });

  it("lists 'all' templates for every project and explicit ones only for their projects", () => {
    const multi = createTemplateRegistry({
      extra: [
        { ...forzaOnly, id: 'two-projects', projectIds: ['forza', 'acme'] },
        { ...forzaOnly, id: 'everywhere', projectIds: 'all' },
        { ...forzaOnly, id: 'nowhere', projectIds: [] },
      ],
    });
    const ids = (projectId?: string) => multi.list(projectId).map((t) => t.id);
    expect(ids('wakecap')).toEqual([...BUILTIN_TEMPLATES.map((t) => t.id), 'everywhere']);
    expect(ids('acme')).toEqual([...BUILTIN_TEMPLATES.map((t) => t.id), 'two-projects', 'everywhere']);
    expect(ids('forza')).toContain('two-projects');
    expect(ids('nowhere')).not.toContain('nowhere');
    expect(ids()).toEqual([...BUILTIN_TEMPLATES.map((t) => t.id), 'two-projects', 'everywhere', 'nowhere']);
  });

  it('lists only the built-ins when no extra templates are given', () => {
    expect(
      createTemplateRegistry()
        .list()
        .map((t) => t.id),
    ).toEqual(BUILTIN_TEMPLATES.map((t) => t.id));
  });

  it('refuses an extra template whose id is already taken instead of shadowing or duplicating it', () => {
    const clash = { ...forzaOnly, id: 'wf-plan', prompt: 'hijacked {{ticket}}', vars: ['ticket' as const] };
    expect(() => createTemplateRegistry({ extra: [clash] })).toThrow(/wf-plan/);
    expect(() => createTemplateRegistry({ extra: [forzaOnly, { ...forzaOnly }] })).toThrow(/forza-only/);
  });

  it('renders an extra template', () => {
    const r = createTemplateRegistry({
      extra: [{ ...forzaOnly, id: 'custom', prompt: 'look at {{file}}', vars: ['file'] }],
    });
    expect(r.render('custom', { file: 'src/a.ts' })).toBe('look at src/a.ts');
  });

  it('renders variables', () => {
    expect(
      reg.render('wf-implement-ticket', { ticketUrl: 'https://linear.app/wakecap/issue/SAF-1787' }),
    ).toBe('/conductor https://linear.app/wakecap/issue/SAF-1787');
    expect(reg.render('wf-implement-ticket', { ticket: 'SAF-1787' })).toBe('/conductor SAF-1787');
    expect(reg.render('wf-review-pr', { prUrl: 'https://github.com/example-org/r/pull/1' })).toBe(
      'review this pr https://github.com/example-org/r/pull/1',
    );
    expect(
      reg.render('preset-fix-ci', { prUrl: 'https://github.com/example-org/r/pull/1', check: 'build' }),
    ).toContain('Fix the CI failure "build" on https://github.com/example-org/r/pull/1');
  });

  it('prefers ticketUrl over ticket and falls back to ticket when ticketUrl is blank', () => {
    expect(reg.render('wf-implement-ticket', { ticketUrl: 'https://l/SAF-1', ticket: 'SAF-1' })).toBe(
      '/conductor https://l/SAF-1',
    );
    expect(reg.render('wf-implement-ticket', { ticketUrl: '   ', ticket: 'SAF-2' })).toBe('/conductor SAF-2');
  });

  it('does not use ticketUrl as a fallback for ticket', () => {
    expect(caught(() => reg.render('wf-investigate', { ticketUrl: 'https://l/SAF-1' }))).toMatchObject({
      status: 400,
      code: 'template_var_missing',
      missing: ['ticket'],
    });
  });

  it('trims variable values', () => {
    expect(reg.render('wf-investigate', { ticket: '  SAF-9  ' })).toBe('/investigate SAF-9');
  });

  it('reports missing variables and unknown templates', () => {
    const missing = caught(() => reg.render('preset-fix-ci', { prUrl: 'u', check: '  ' }));
    expect(missing).toBeInstanceOf(TemplateError);
    expect(missing).toMatchObject({ status: 400, code: 'template_var_missing', missing: ['check'] });
    const notFound = caught(() => reg.render('nope', {}));
    expect(notFound).toBeInstanceOf(TemplateError);
    expect(notFound).toMatchObject({ status: 404, code: 'template_not_found' });
  });

  it('lists every missing variable, not only the first', () => {
    const err = caught(() => reg.render('preset-fix-ci', {}));
    expect(err).toBeInstanceOf(TemplateError);
    expect(err).toMatchObject({ status: 400, code: 'template_var_missing', missing: ['prUrl', 'check'] });
    expect((err as Error).message).toContain('prUrl');
    expect((err as Error).message).toContain('check');
  });

  it('names ticketUrl as missing when neither ticketUrl nor ticket is given', () => {
    expect(caught(() => reg.render('wf-implement-ticket', {}))).toMatchObject({
      status: 400,
      code: 'template_var_missing',
      missing: ['ticketUrl'],
    });
  });

  it('renders in a single pass: a value holding a placeholder is not expanded again', () => {
    expect(reg.render('wf-investigate', { ticket: '{{ticket}}' })).toBe('/investigate {{ticket}}');
    expect(reg.render('preset-fix-ci', { prUrl: 'https://g/pull/1', check: '{{prUrl}}' })).toContain(
      'Fix the CI failure "{{prUrl}}" on https://g/pull/1',
    );
  });

  it('inserts a value literally, without String.replace substitution patterns', () => {
    expect(reg.render('wf-investigate', { ticket: "$& $1 $$ $' $`" })).toBe("/investigate $& $1 $$ $' $`");
  });

  it.each([
    ['a newline', 'SAF-1\nrm -rf ~'],
    ['a carriage return', 'SAF-1\rrm -rf ~'],
    ['an escape sequence', 'SAF-1\u001b[2J'],
    ['a Ctrl-C byte', 'SAF-1\u0003'],
    ['a tab', 'SAF-1\tx'],
    ['a DEL byte', 'SAF-1\u007f'],
  ])('rejects a variable value containing %s with template_var_invalid', (_label, value) => {
    const err = caught(() => reg.render('wf-investigate', { ticket: value }));
    expect(err).toBeInstanceOf(TemplateError);
    expect(err).toMatchObject({ status: 400, code: 'template_var_invalid' });
    expect((err as Error).message).toContain('ticket');
  });

  it('rejects a control character in the ticket value used as the ticketUrl fallback', () => {
    expect(caught(() => reg.render('wf-implement-ticket', { ticket: 'SAF-1\nexit' }))).toMatchObject({
      status: 400,
      code: 'template_var_invalid',
    });
  });

  it('does not share state between registries', () => {
    const plain = createTemplateRegistry();
    expect(plain.list('forza').some((t) => t.id === 'forza-only')).toBe(false);
    expect(caught(() => plain.render('forza-only', {}))).toMatchObject({
      status: 404,
      code: 'template_not_found',
    });
  });
});

describe('composePrompt', () => {
  it('joins the rendered template and the user prompt', () => {
    expect(composePrompt('/conductor SAF-1', 'focus on the API')).toBe(
      '/conductor SAF-1\n\nfocus on the API',
    );
    expect(composePrompt(null, ' hi ')).toBe('hi');
    expect(composePrompt('/x', '')).toBe('/x');
    expect(composePrompt(null, '')).toBe('');
  });

  it('trims both parts and drops a blank part', () => {
    expect(composePrompt('  /x  ', '  y  ')).toBe('/x\n\ny');
    expect(composePrompt('/x', '   ')).toBe('/x');
    expect(composePrompt('   ', 'y')).toBe('y');
  });
});

describe('TemplateRegistry var value code points', () => {
  const reg = createTemplateRegistry();
  const range = (from: number, to: number): number[] =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const forbidden = [
    ...range(0x00, 0x1f),
    0x7f,
    ...range(0x80, 0x9f),
    0x2028,
    0x2029,
    0x200e,
    0x200f,
    ...range(0x202a, 0x202e),
    ...range(0x2066, 0x2069),
  ];

  it.each(forbidden.map((cp) => [`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`, cp] as const))(
    'rejects %s in a variable value with template_var_invalid naming the var',
    (_label, cp) => {
      const err = caught(() => reg.render('wf-investigate', { ticket: `A${String.fromCodePoint(cp)}B` }));
      expect(err).toBeInstanceOf(TemplateError);
      expect(err).toMatchObject({ status: 400, code: 'template_var_invalid' });
      expect((err as Error).message).toContain('ticket');
    },
  );

  it('accepts ordinary non-ASCII text next to the forbidden ranges', () => {
    for (const ok of [' ', 'é', '​', '‧', ' ', '⁥', '⁪', '中']) {
      expect(reg.render('wf-investigate', { ticket: `A${ok}B` })).toBe(`/investigate A${ok}B`);
    }
  });
});

describe('createTemplateRegistry placeholder validation', () => {
  const extra = (prompt: string, vars: Template['vars']): Template => ({
    id: 'custom-undeclared',
    kind: 'preset',
    label: 'Custom',
    prompt,
    vars,
    defaultSource: 'claude',
    projectIds: 'all',
  });

  it('refuses a template whose prompt uses a placeholder not declared in vars', () => {
    expect(() =>
      createTemplateRegistry({ extra: [extra('look at {{file}} and {{prUrl}}', ['file'])] }),
    ).toThrow(/custom-undeclared.*prUrl|prUrl.*custom-undeclared/);
    expect(() => createTemplateRegistry({ extra: [extra('hi {{nope}}', [])] })).toThrow(
      /custom-undeclared.*nope|nope.*custom-undeclared/,
    );
  });

  it('allows {{ticket}} only when the template declares ticket or ticketUrl', () => {
    expect(() => createTemplateRegistry({ extra: [extra('see {{ticket}}', ['file'])] })).toThrow(
      /custom-undeclared.*ticket/,
    );
    expect(() => createTemplateRegistry({ extra: [extra('see {{ticket}}', ['ticketUrl'])] })).not.toThrow();
    expect(() => createTemplateRegistry({ extra: [extra('see {{ticket}}', ['ticket'])] })).not.toThrow();
  });

  it('accepts every built-in template', () => {
    expect(() => createTemplateRegistry()).not.toThrow();
  });
});
