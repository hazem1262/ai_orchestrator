import { redactDeep } from '@orc/core';

const MAX_STRING = 2000;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;

function clamp(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) return '«truncated»';
    return v.slice(0, MAX_ARRAY).map((x) => clamp(x, depth + 1));
  }
  if (v !== null && typeof v === 'object') {
    if (depth >= MAX_DEPTH) return '«truncated»';
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clamp(x, depth + 1)]),
    );
  }
  return v;
}

/** Audit params are redacted (values and sensitive keys) and size-bounded before storage. */
export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  return clamp(redactDeep(params), 0) as Record<string, unknown>;
}
