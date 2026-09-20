import { describe, expect, it } from 'vitest';
import { deriveAvailability } from './availability.ts';
import { deriveName, NAME_MAX, truncate } from './name.ts';
import { compileProdPatterns, DEFAULT_PROD_PATTERNS, matchesProd } from './prod.ts';
import { detectProjects, projectRootFor, slugify } from './projects.ts';
import { mcpServerOf, mcpToolLabel, slashCommand } from './skills.ts';
import { compileTicketRegex, DEFAULT_TICKET_REGEX, extractTickets } from './tickets.ts';
import { addUnique } from './util.ts';

describe('name', () => {
  it('truncates and collapses whitespace', () => {
    expect(truncate('  a \n b  ')).toBe('a b');
    const long = truncate('x'.repeat(200));
    expect(long).toHaveLength(NAME_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('prefers agent-name, then custom title, ai-title, summary, first prompt', () => {
    const base = { agentName: null, customTitle: null, aiTitle: null, summary: null, firstPrompt: null };
    expect(deriveName(base)).toBeNull();
    expect(deriveName({ ...base, firstPrompt: 'fix it' })).toBe('fix it');
    expect(deriveName({ ...base, summary: 'S', firstPrompt: 'fix it' })).toBe('S');
    expect(deriveName({ ...base, aiTitle: 'AI', summary: 'S' })).toBe('AI');
    expect(deriveName({ ...base, customTitle: 'C', aiTitle: 'AI' })).toBe('C');
    expect(deriveName({ ...base, agentName: 'A', customTitle: 'C', aiTitle: 'AI' })).toBe('A');
    expect(deriveName({ ...base, agentName: '   ', aiTitle: 'AI' })).toBe('AI');
  });
});

describe('tickets', () => {
  const re = compileTicketRegex(DEFAULT_TICKET_REGEX);
  it('extracts unique tickets in order, including from branch names', () => {
    expect(extractTickets('git checkout -b feat/SAF-1787-exclude; see SUPRT-12 and SAF-1787', re)).toEqual([
      'SAF-1787',
      'SUPRT-12',
    ]);
  });
  it('returns nothing without a regex or for invalid regex source', () => {
    expect(extractTickets('SAF-1', null)).toEqual([]);
    expect(compileTicketRegex('(')).toBeNull();
    expect(compileTicketRegex(null)).toBeNull();
  });
  it('addUnique keeps order and skips duplicates', () => {
    const list = ['a'];
    addUnique(list, ['b', 'a', 'c', 'b']);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});

describe('skills and mcp', () => {
  it('reads slash commands only at the start and skips built-ins and paths', () => {
    expect(slashCommand('/review the change')).toBe('review');
    expect(slashCommand('/conductor SAF-1')).toBe('conductor');
    expect(slashCommand('  /long-scan')).toBe('long-scan');
    expect(slashCommand('/clear')).toBeNull();
    expect(slashCommand('/Users/test/Wakecap is slow')).toBeNull();
    expect(slashCommand('use /conductor')).toBeNull();
  });
  it('parses mcp tool names', () => {
    expect(mcpServerOf('mcp__claude_ai_Linear__save_issue')).toBe('claude_ai_Linear');
    expect(mcpServerOf('Bash')).toBeNull();
    expect(mcpToolLabel('mcp__claude_ai_Linear__save_issue')).toBe('Linear save_issue');
    expect(mcpToolLabel('mcp__plugin_context7_context7__query-docs')).toBe('context7 query-docs');
    expect(mcpToolLabel('Bash')).toBe('Bash');
  });
});

describe('prod patterns', () => {
  const res = compileProdPatterns([...DEFAULT_PROD_PATTERNS, '(']);
  it('matches prod skills and commands, ignores normal commands', () => {
    expect(matchesProd('production_server_db', res)).toBe(true);
    expect(matchesProd("PGPASSWORD=x psql -h prod-db.internal -c 'select 1'", res)).toBe(true);
    expect(matchesProd('kubectl --context eks-production get pods', res)).toBe(true);
    expect(matchesProd('terraform apply -auto-approve', res)).toBe(true);
    expect(matchesProd('pnpm vitest run', res)).toBe(false);
    expect(res).toHaveLength(DEFAULT_PROD_PATTERNS.length);
  });
});

describe('availability', () => {
  it('orders resumable > archived > prompts-only', () => {
    expect(deriveAvailability({ transcriptExists: true, archived: true })).toBe('resumable');
    expect(deriveAvailability({ transcriptExists: false, archived: true })).toBe('archived');
    expect(deriveAvailability({ transcriptExists: false, archived: false })).toBe('prompts-only');
  });
});

describe('projects', () => {
  it('finds the top-level folder under the user home', () => {
    expect(projectRootFor('/Users/test/Wakecap/Backend/svc', '/Users/test')).toBe('/Users/test/Wakecap');
    expect(projectRootFor('/Users/test', '/Users/test/')).toBe('/Users/test');
    expect(projectRootFor('/tmp/x/y', '/Users/test')).toBe('/tmp');
    expect(slugify('EGX Investment!')).toBe('egx-investment');
    expect(slugify('***')).toBe('project');
  });

  it('groups sessions by root and orders by recent activity', () => {
    const out = detectProjects(
      [
        { cwd: '/Users/test/Wakecap', lastActivityAt: '2026-09-01T09:07:00.000Z' },
        { cwd: '/Users/test/Forza', lastActivityAt: '2026-09-04T08:00:01.000Z' },
        { cwd: '/Users/test/Stocks/EGX Investment Research', lastActivityAt: '2026-09-01T09:06:40.000Z' },
        { cwd: '/Users/test/Wakecap/Backend/svc', lastActivityAt: '2026-09-06T08:00:02.000Z' },
        { cwd: '/Users/test', lastActivityAt: '2026-08-01T00:00:00.000Z' },
      ],
      '/Users/test',
    );
    expect(out.map((p) => [p.id, p.name, p.pathPrefix, p.sessionCount])).toEqual([
      ['wakecap', 'Wakecap', '/Users/test/Wakecap', 2],
      ['forza', 'Forza', '/Users/test/Forza', 1],
      ['stocks', 'Stocks', '/Users/test/Stocks', 1],
      ['home', 'Home', '/Users/test', 1],
    ]);
    expect(out[0]?.lastActivityAt).toBe('2026-09-06T08:00:02.000Z');
  });

  it('de-duplicates ids', () => {
    const out = detectProjects(
      [
        { cwd: '/Users/test/a b', lastActivityAt: '2026-01-02' },
        { cwd: '/Users/test/a-b', lastActivityAt: '2026-01-01' },
      ],
      '/Users/test',
    );
    expect(out.map((p) => p.id)).toEqual(['a-b', 'a-b-2']);
  });
});
