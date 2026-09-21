import type { PtyInfo, PtyManager } from '../src/pty/pty-manager.ts';

/**
 * In-memory `PtyManager` for tests that need PTY *ownership* without a real terminal. Nothing
 * here spawns, signals or kills an OS process: `spawn` fabricates a `PtyInfo` with a synthetic
 * pid, and `kill` only records the call and stamps `exitedAt`.
 */
export function createFakePty(initial: PtyInfo[] = []): PtyManager & {
  infos: PtyInfo[];
  spawned: Array<Parameters<PtyManager['spawn']>[0]>;
  killed: Array<{ id: string; signal?: NodeJS.Signals }>;
} {
  const infos = [...initial];
  const spawned: Array<Parameters<PtyManager['spawn']>[0]> = [];
  const killed: Array<{ id: string; signal?: NodeJS.Signals }> = [];
  let next = 90000;
  return {
    infos,
    spawned,
    killed,
    spawn(opts) {
      spawned.push(opts);
      const info: PtyInfo = {
        id: `pty-${infos.length + 1}`,
        sessionPk: opts.sessionPk ?? null,
        command: opts.command,
        args: opts.args,
        cwd: opts.cwd,
        pid: next++,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 36,
      };
      infos.push(info);
      return info;
    },
    write() {},
    async sendText() {},
    resize() {},
    kill(id, signal) {
      killed.push({ id, signal });
      const i = infos.find((p) => p.id === id);
      if (i) i.exitedAt = new Date().toISOString();
    },
    attach() {
      return { scrollback: '', detach() {} };
    },
    list: () => infos,
    get: (id) => infos.find((p) => p.id === id),
    remove(id) {
      const at = infos.findIndex((p) => p.id === id);
      if (at >= 0) infos.splice(at, 1);
    },
    disposeAll() {
      infos.length = 0;
    },
  };
}
