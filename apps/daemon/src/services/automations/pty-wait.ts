import type { LiveStatus } from '@orc/core';
import type { EventBus } from '../../live/event-bus.ts';

export type PtyTurnOutcome =
  | { kind: 'done'; status: LiveStatus }
  | { kind: 'exited'; code: number | null }
  | { kind: 'timeout' };

const TURN_END: ReadonlySet<LiveStatus> = new Set<LiveStatus>([
  'idle',
  'waiting',
  'review',
  'blocked',
  'error',
]);

/** Resolves when the owned session has been busy and then stops (idle/waiting/review/…), exits, or times out. */
export function waitForPtyTurn(
  bus: EventBus,
  pk: string,
  ptyId: string,
  timeoutMs: number,
): Promise<PtyTurnOutcome> {
  return new Promise((resolve) => {
    let sawBusy = false;
    const offs: Array<() => void> = [];
    const finish = (o: PtyTurnOutcome) => {
      clearTimeout(timer);
      for (const off of offs) off();
      resolve(o);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    offs.push(
      bus.on('session.statusChanged', (e) => {
        if (e.pk !== pk) return;
        if (e.to === 'busy') sawBusy = true;
        else if (sawBusy && TURN_END.has(e.to)) finish({ kind: 'done', status: e.to });
      }),
    );
    offs.push(
      bus.on('pty.exited', (e) => {
        if (e.ptyId === ptyId) finish({ kind: 'exited', code: e.code });
      }),
    );
  });
}
