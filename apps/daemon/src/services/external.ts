import { execa } from 'execa';

export type ExternalLauncher = (i: {
  cwd: string;
  command: string;
  args: string[];
  openIn: 'vscode' | 'terminal' | 'finder';
}) => Promise<void>;

export type CommandRunner = (file: string, args: string[]) => Promise<unknown>;

export function shellQuote(parts: string[]): string {
  return parts.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)).join(' ');
}

export function resumeCommandLine(cwd: string, command: string, args: string[]): string {
  return `cd ${shellQuote([cwd])} && ${shellQuote([command, ...args])}`;
}

export function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Pop-out / external resume (F4). VS Code and Finder cannot receive the command; the UI copies it instead. */
export function createExternalLauncher(
  run: CommandRunner = (file, args) => execa(file, args),
): ExternalLauncher {
  return async (i) => {
    if (i.openIn === 'vscode') {
      await run('code', ['--new-window', i.cwd]);
      return;
    }
    if (i.openIn === 'finder') {
      await run('open', [i.cwd]);
      return;
    }
    const line = resumeCommandLine(i.cwd, i.command, i.args);
    await run('osascript', [
      '-e',
      `tell application "Terminal" to do script ${appleScriptString(line)}`,
      '-e',
      'tell application "Terminal" to activate',
    ]);
  };
}
