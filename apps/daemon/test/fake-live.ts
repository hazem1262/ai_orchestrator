import type { Session } from '@orc/core';
import type { HookEvent, LiveTracker } from '../src/live/live-tracker.ts';

/**
 * An in-memory `LiveTracker` for route and socket tests: no registry watcher, no `ps`, no
 * transcripts. `sessions` is writable so a test can change what `list()` returns mid-flight, and
 * `hooks`/`pids` record what the code under test asked the tracker to do.
 */
export function createFakeLive(
  sessions: Session[] = [],
): LiveTracker & { sessions: Session[]; hooks: HookEvent[]; pids: Map<number, string> } {
  const hooks: HookEvent[] = [];
  const pids = new Map<number, string>();
  const state = { sessions };
  return {
    get sessions() {
      return state.sessions;
    },
    set sessions(v: Session[]) {
      state.sessions = v;
    },
    hooks,
    pids,
    async start() {},
    async stop() {},
    async refresh() {},
    list: () => state.sessions,
    get: (pk) => state.sessions.find((s) => `${s.source}:${s.id}` === pk) ?? null,
    waitForPid: async (pid) => pids.get(pid) ?? null,
    applyHook: (e) => void hooks.push(e),
  };
}
