/**
 * Bracketed-paste encoding and scripted text submission for a PTY.
 *
 * Pure: no fs, no child_process, no net. The caller supplies a `write`
 * function (e.g. `pty.write`) so this module has no dependency on
 * node-pty or any specific transport.
 */

export function encodePaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

export async function sendText(
  write: (d: string) => void,
  text: string,
  opts: { submitDelayMs?: number } = {},
): Promise<void> {
  write(encodePaste(text));
  await new Promise((r) => setTimeout(r, opts.submitDelayMs ?? 120));
  write('\r');
}
