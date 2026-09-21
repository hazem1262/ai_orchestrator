export interface CodexEnvelope {
  timestamp: string;
  ordinal: number | null;
  type: string;
  payload: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseCodexEnvelope(value: unknown): CodexEnvelope | null {
  if (!isObj(value)) return null;
  const { timestamp, type, payload, ordinal } = value;
  if (typeof timestamp !== 'string' || typeof type !== 'string' || !isObj(payload)) return null;
  return { timestamp, type, payload, ordinal: typeof ordinal === 'number' ? ordinal : null };
}

/** Parses function_call `arguments` (JSON string or object) and returns the shell command line, if any. */
export function codexShellCommand(args: unknown): string | null {
  let v: unknown = args;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!isObj(v)) return null;
  const c = v.command ?? v.cmd;
  if (Array.isArray(c)) return c.map(String).join(' ');
  return typeof c === 'string' ? c : null;
}
