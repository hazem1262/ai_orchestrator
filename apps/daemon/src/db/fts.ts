/** Turns free text into an FTS5 query: every word becomes a quoted prefix term, all terms must match. */
export function toFtsQuery(input: string): string | null {
  const tokens = input.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens
    .slice(0, 8)
    .map((t) => `"${t}"*`)
    .join(' ');
}

export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
