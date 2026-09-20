import { describe, expect, it } from 'vitest';
import { appleScriptString, createExternalLauncher, resumeCommandLine, shellQuote } from './external.ts';

describe('external launcher', () => {
  it('quotes shell words', () => {
    expect(shellQuote(['claude', '--resume', 'abc-123'])).toBe('claude --resume abc-123');
    expect(shellQuote(["/tmp/it's here", 'a b'])).toBe("'/tmp/it'\\''s here' 'a b'");
    expect(resumeCommandLine('/Users/test/Stocks/EGX Research', 'claude', ['--resume', 'x'])).toBe(
      "cd '/Users/test/Stocks/EGX Research' && claude --resume x",
    );
    expect(appleScriptString('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
  });

  it('opens Terminal.app with the resume command', async () => {
    const calls: Array<[string, string[]]> = [];
    const launch = createExternalLauncher(async (file, args) => {
      calls.push([file, args]);
    });
    await launch({ cwd: '/w', command: 'claude', args: ['--resume', 's1'], openIn: 'terminal' });
    expect(calls).toEqual([
      [
        'osascript',
        [
          '-e',
          'tell application "Terminal" to do script "cd /w && claude --resume s1"',
          '-e',
          'tell application "Terminal" to activate',
        ],
      ],
    ]);
  });

  it('opens VS Code or Finder at the cwd', async () => {
    const calls: Array<[string, string[]]> = [];
    const launch = createExternalLauncher(async (file, args) => {
      calls.push([file, args]);
    });
    await launch({ cwd: '/w', command: 'claude', args: [], openIn: 'vscode' });
    await launch({ cwd: '/w', command: 'claude', args: [], openIn: 'finder' });
    expect(calls).toEqual([
      ['code', ['--new-window', '/w']],
      ['open', ['/w']],
    ]);
  });
});
