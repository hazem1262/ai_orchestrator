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

type SpawnOpts = Parameters<PtyManager['spawn']>[0];

export function recordingPty(): PtyManager & {
  spawned: SpawnOpts[];
  texts: Array<{ id: string; text: string }>;
  writes: Array<{ id: string; data: string }>;
} {
  const infos = new Map<string, PtyInfo>();
  const spawned: SpawnOpts[] = [];
  const texts: Array<{ id: string; text: string }> = [];
  const writes: Array<{ id: string; data: string }> = [];
  let n = 0;
  return {
    spawned,
    texts,
    writes,
    spawn(opts) {
      spawned.push(opts);
      n += 1;
      const info: PtyInfo = {
        id: `pty-${n}`,
        sessionPk: opts.sessionPk ?? null,
        command: opts.command,
        args: opts.args,
        cwd: opts.cwd,
        pid: 10_000 + n,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 36,
      };
      infos.set(info.id, info);
      return info;
    },
    write(id, data) {
      writes.push({ id, data });
    },
    async sendText(id, text) {
      texts.push({ id, text });
    },
    resize() {},
    kill(id) {
      const info = infos.get(id);
      if (info) infos.set(id, { ...info, exitedAt: new Date().toISOString(), exitCode: 0 });
    },
    attach() {
      return { scrollback: '', detach() {} };
    },
    list: () => [...infos.values()],
    get: (id) => infos.get(id),
    remove(id) {
      infos.delete(id);
    },
    disposeAll() {
      infos.clear();
    },
  };
}
