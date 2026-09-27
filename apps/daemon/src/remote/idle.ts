import { type RunCommand, runCommand } from './tailscale.ts';

/** `ioreg -c IOHIDSystem` prints `"HIDIdleTime" = <nanoseconds since last keyboard/mouse input>`. */
export function parseHidIdleSeconds(ioregOutput: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioregOutput);
  return m?.[1] ? Math.floor(Number(m[1]) / 1e9) : null;
}

/** Seconds since the last keyboard or mouse input; `null` off macOS or when `ioreg` fails. */
export async function readIdleSeconds(
  o: { run?: RunCommand; platform?: NodeJS.Platform } = {},
): Promise<number | null> {
  if ((o.platform ?? process.platform) !== 'darwin') return null;
  try {
    return parseHidIdleSeconds(await (o.run ?? runCommand)('ioreg', ['-c', 'IOHIDSystem']));
  } catch {
    return null;
  }
}
