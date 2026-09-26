import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type M4State, STATE_FILE } from './m4-seed';

/** PTY children run in their own session, so the daemon's process group does not cover them. */
function killFakeAgents(dir: string): void {
  const reg = join(dir, 'claude', 'sessions');
  if (!existsSync(reg)) return;
  for (const f of readdirSync(reg)) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const { pid, cwd } = JSON.parse(readFileSync(join(reg, f), 'utf8')) as { pid: number; cwd: string };
      // Only a process this run started: its cwd lives under the temp dir.
      if (typeof pid === 'number' && typeof cwd === 'string' && cwd.startsWith(dir))
        process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

export default async function globalTeardown(): Promise<void> {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as M4State;
  killFakeAgents(state.dir);
  try {
    process.kill(-state.pid, 'SIGTERM');
  } catch {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, 500));
  rmSync(state.dir, { recursive: true, force: true });
  rmSync(STATE_FILE, { force: true });
}
