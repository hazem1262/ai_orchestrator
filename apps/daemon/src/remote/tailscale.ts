import { execa } from 'execa';

export type RunCommand = (cmd: string, args: string[]) => Promise<string>;

const defaultRun: RunCommand = async (cmd, args) => (await execa(cmd, args, { timeout: 5000 })).stdout;

/**
 * `tailscale serve status --json` lists Funnel-enabled host:ports under `AllowFunnel`. Spike S9
 * check (h) has not confirmed the key yet (plan/spikes/S9.md); update this if it differs.
 */
export function detectFunnel(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false;
  const allow = (status as { AllowFunnel?: unknown }).AllowFunnel;
  if (!allow || typeof allow !== 'object') return false;
  return Object.values(allow as Record<string, unknown>).some((v) => v === true);
}

/** Read-only status call; `null` when tailscale is missing or the output is not JSON. */
export async function readServeStatus(run: RunCommand = defaultRun): Promise<unknown> {
  try {
    const out = await run('tailscale', ['serve', 'status', '--json']);
    return out.trim() ? JSON.parse(out) : {};
  } catch {
    return null;
  }
}

export interface FunnelWatch {
  detected(): boolean;
  refresh(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export function createFunnelWatch(
  o: { run?: RunCommand; intervalMs?: number; log?: { warn(obj: object, msg?: string): void } } = {},
): FunnelWatch {
  let detected = false;
  let timer: NodeJS.Timeout | null = null;
  const refresh = async () => {
    const was = detected;
    detected = detectFunnel(await readServeStatus(o.run));
    if (detected && !was)
      o.log?.warn({}, 'Tailscale Funnel detected: remote access is blocked until it is turned off');
    return detected;
  };
  return {
    detected: () => detected,
    refresh,
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), o.intervalMs ?? 60_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
