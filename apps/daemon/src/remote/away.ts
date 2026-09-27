import type { AwayMode, AwayState, OrcConfig } from '@orc/api-contract';
import type { EventBus } from '../live/event-bus.ts';
import type { Notifier } from '../notify/notifier.ts';
import { readIdleSeconds } from './idle.ts';

export interface AwayService {
  state(): AwayState;
  setMode(mode: AwayMode): Promise<AwayState>;
  tick(): Promise<AwayState>;
  start(): void;
  stop(): void;
}

/**
 * Away mode. `on` and `off` are manual; `auto` is away once macOS idle time reaches
 * `away.idleMinutes`. The mode lives in memory, so a restart starts in `auto`. A change of the
 * away flag calls `notifier.setAway()` and emits `away.changed`.
 */
export function createAwayService(d: {
  config: () => OrcConfig;
  notifier: Notifier;
  bus: EventBus;
  idle?: () => Promise<number | null>;
  intervalMs?: number;
}): AwayService {
  const idle = d.idle ?? (() => readIdleSeconds());
  let mode: AwayMode = 'auto';
  let current: AwayState = { away: false, mode, reason: 'present', idleSeconds: null };
  let timer: NodeJS.Timeout | null = null;

  function apply(next: AwayState): AwayState {
    const changed = next.away !== current.away;
    current = next;
    if (changed) {
      d.notifier.setAway(next.away);
      d.bus.emit({ type: 'away.changed', away: next.away, reason: next.reason });
    }
    return current;
  }

  async function evaluate(): Promise<AwayState> {
    if (mode === 'on') return apply({ away: true, mode, reason: 'manual', idleSeconds: current.idleSeconds });
    if (mode === 'off')
      return apply({ away: false, mode, reason: 'manual', idleSeconds: current.idleSeconds });
    const cfg = d.config().away;
    const secs = cfg.auto ? await idle() : null;
    // A manual mode set while `idle()` was pending wins over this stale auto evaluation.
    if (mode !== 'auto') return current;
    const away = secs !== null && secs >= cfg.idleMinutes * 60;
    return apply({ away, mode, reason: away ? 'idle' : 'present', idleSeconds: secs });
  }

  return {
    state: () => current,
    async setMode(m) {
      mode = m;
      return evaluate();
    },
    tick: evaluate,
    start() {
      if (timer) return;
      void evaluate();
      timer = setInterval(() => void evaluate(), d.intervalMs ?? 30_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
