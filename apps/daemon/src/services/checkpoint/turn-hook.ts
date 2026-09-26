import type { DaemonContext } from '../../context.ts';

export function registerCheckpointHook(ctx: DaemonContext): () => void {
  const queue = new Map<string, Promise<void>>();
  return ctx.bus.on('session.turnEnded', (e) => {
    const s = ctx.sessions.getByPk(e.pk);
    if (s?.live?.ownership !== 'owned') return;
    const cwd = s.cwds[s.cwds.length - 1] ?? s.startCwd;
    const wt = ctx.worktrees?.findByCwd(cwd) ?? null;
    if (!wt || wt.isMain || !ctx.checkpoints) return;
    const checkpoints = ctx.checkpoints;
    const prev = queue.get(wt.path) ?? Promise.resolve();
    const next = prev
      .then(() => checkpoints.create(e.pk, wt.path, e.turn))
      .then(() => undefined)
      .catch((err: unknown) => ctx.log.warn({ err, pk: e.pk, turn: e.turn }, 'turn checkpoint failed'));
    queue.set(wt.path, next);
  });
}
