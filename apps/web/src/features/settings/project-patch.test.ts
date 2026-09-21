import { ProjectConfig } from '@orc/api-contract';
import { describe, expect, it } from 'vitest';
import { buildProjectPatch } from './project-patch.ts';

const cfg = ProjectConfig.parse({ id: 'forza', name: 'Forza', pathPrefixes: ['/Users/test/Forza'] });
const same = {
  name: 'Forza',
  prefixes: '/Users/test/Forza',
  hidden: false,
  openIn: 'vscode' as const,
  ticketRegex: '',
};

describe('buildProjectPatch', () => {
  it('is empty when nothing changed', () => {
    expect(buildProjectPatch(cfg, same)).toEqual({});
    expect(buildProjectPatch(cfg, { ...same, name: '  ', prefixes: '\n' })).toEqual({});
  });

  it('includes only changed fields', () => {
    expect(
      buildProjectPatch(cfg, {
        name: ' Forza App ',
        prefixes: '/Users/test/Forza\n /Users/test/forza-web \n',
        hidden: true,
        openIn: 'terminal',
        ticketRegex: '\\bFZ-\\d+\\b',
      }),
    ).toEqual({
      name: 'Forza App',
      pathPrefixes: ['/Users/test/Forza', '/Users/test/forza-web'],
      hidden: true,
      openIn: 'terminal',
      ticketRegex: '\\bFZ-\\d+\\b',
    });
  });

  it('clears the ticket regex with an empty field', () => {
    const withRegex = ProjectConfig.parse({ ...cfg, ticketRegex: 'X-\\d+' });
    expect(buildProjectPatch(withRegex, { ...same, ticketRegex: ' ' })).toEqual({ ticketRegex: null });
  });
});
