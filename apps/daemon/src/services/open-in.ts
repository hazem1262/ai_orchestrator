import type { OpenInApp } from '@orc/api-contract';
import { defaultExec, type ExecFn } from '../live/liveness.ts';

/** argv only; the path is a single element and never passes through a shell. */
export function openInCommand(
  app: OpenInApp,
  path: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const mac = platform === 'darwin';
  switch (app) {
    case 'vscode':
      return { command: 'code', args: [path] };
    case 'terminal':
      return mac
        ? { command: 'open', args: ['-a', 'Terminal', path] }
        : { command: 'x-terminal-emulator', args: ['--working-directory', path] };
    case 'finder':
      return mac ? { command: 'open', args: [path] } : { command: 'xdg-open', args: [path] };
  }
}

export async function openIn(app: OpenInApp, path: string, exec: ExecFn = defaultExec): Promise<void> {
  const c = openInCommand(app, path);
  const r = await exec(c.command, c.args);
  if (r.exitCode !== 0) throw new Error(`${c.command} exited with ${r.exitCode}`);
}
