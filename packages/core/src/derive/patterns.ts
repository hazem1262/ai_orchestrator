const cache = new Map<string, RegExp>();

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compiles a user/config pattern as a case-insensitive regex. Invalid regex source is matched literally. */
export function compilePattern(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = new RegExp(escapeRegex(pattern), 'i');
  }
  cache.set(pattern, re);
  return re;
}

export function firstMatch(
  text: string,
  patterns: readonly string[],
): { pattern: string; match: string } | null {
  for (const pattern of patterns) {
    const m = compilePattern(pattern).exec(text);
    if (m) return { pattern, match: m[0] };
  }
  return null;
}
