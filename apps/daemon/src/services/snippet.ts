import { SNIPPET_CLOSE, SNIPPET_OPEN } from '@orc/api-contract';
import { redact } from '@orc/core';

export function highlight(text: string, needle: string, radius = 40): string {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0 || needle.length === 0) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + needle.length + radius);
  return [
    start > 0 ? '…' : '',
    text.slice(start, i),
    SNIPPET_OPEN,
    text.slice(i, i + needle.length),
    SNIPPET_CLOSE,
    text.slice(i + needle.length, end),
    end < text.length ? '…' : '',
  ].join('');
}

/**
 * `highlight()` truncates by raw character offset (±`radius` around the matched needle), not
 * token boundaries — so redacting the *output* of `highlight()` can miss a secret pattern that
 * the truncation cut in half (e.g. `PGPASSWORD=hunter2` truncated to `SSWORD=hunter2` no longer
 * matches the `password|...=` pattern `redact()` anchors on; a length-gated token like a `ghp_`
 * secret can likewise be cut below its own length gate). Always redact the full, untruncated raw
 * text FIRST, then run `highlight()` on the already-redacted text — every secret pattern is
 * matched intact before any cut can touch it, and the needle search naturally lands on whichever
 * copy of the text it is run against, so this order requires no offset bookkeeping. See
 * task-19-report.md's "Fix round 3" for the leak this closes and its regression tests.
 */
export function redactedHighlight(text: string, needle: string, radius = 40): string {
  return highlight(redact(text), needle, radius);
}
