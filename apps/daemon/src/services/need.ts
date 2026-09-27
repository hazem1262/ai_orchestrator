/** Returns a DaemonContext service that is typed optional but must be wired by now. */
export function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is not wired in DaemonContext`);
  return value;
}
