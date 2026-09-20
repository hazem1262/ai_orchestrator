/**
 * A prefix match on a token whose matching-term cardinality is wide (a short/generic token, or
 * one that happens to be a numeric or alphanumeric prefix shared by hundreds of distinct terms)
 * forces FTS5 to scan its whole term dictionary and then pay a per-output-row cost in
 * `snippet()` proportional to that cardinality — measured at ~80 ms/row for a ~1,100-term
 * fan-out, i.e. seconds for a page of results (see task-19-report.md's "Fix round 1"/"Fix round
 * 2" sections). Two committed tokens each independently prefix-matching hundreds of terms is the
 * worst case, since FTS5 then has to intersect two wide match sets.
 */
const MIN_PREFIX_LEN = 3;

/**
 * Turns free text into an FTS5 query, matching the search-as-you-type convention: only the last
 * (still-being-typed) token is a prefix match, so `"notif"` still finds "notification" as the
 * user types it. Every earlier token is a token the user has already finished typing, so it
 * becomes an exact term match instead of a prefix — this is what actually bounds the query cost
 * (see `MIN_PREFIX_LEN`'s comment): a query no longer needs two wide-fan-out prefixes to
 * intersect, at most one. A final token shorter than `MIN_PREFIX_LEN` is also matched exactly
 * rather than as a prefix — a 1-2 character prefix is close to a full-dictionary scan and is
 * almost never a useful search on its own.
 */
function tokenize(input: string): string[] {
  return (input.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 8);
}

export function toFtsQuery(input: string): string | null {
  const tokens = tokenize(input);
  if (tokens.length === 0) return null;
  const lastIndex = tokens.length - 1;
  return tokens
    .map((t, i) => (i === lastIndex && t.length >= MIN_PREFIX_LEN ? `"${t}"*` : `"${t}"`))
    .join(' ');
}

/**
 * The token `toFtsQuery` turned into a prefix match, if any — `null` when the query has no
 * prefix term at all (every token too short, or the query is empty). Callers use this to decide
 * whether it's worth running a cheap term-cardinality check (`ftsPrefixCardinality` in
 * `db/repos/events.ts`) before paying FTS5's `snippet()` cost, which scales with that prefix's
 * matching-term count.
 */
export function ftsPrefixToken(input: string): string | null {
  const tokens = tokenize(input);
  if (tokens.length === 0) return null;
  const last = tokens.at(-1) as string;
  return last.length >= MIN_PREFIX_LEN ? last : null;
}

export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
