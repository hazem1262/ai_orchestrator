import { SNIPPET_CLOSE, SNIPPET_OPEN } from '@orc/api-contract';
import { redact } from '@orc/core';
import { describe, expect, it } from 'vitest';
import { highlight, redactedHighlight } from './snippet.ts';

/**
 * Fix round 3 (CRITICAL): the wide-fan-out fallback path (services/sessions.ts) originally
 * called `redact(highlight(raw, needle))` — truncate first, redact second. `highlight()` cuts by
 * raw character offset (±40 chars around the matched needle), not token boundaries, so the cut
 * can bisect the very secret pattern `redact()` anchors on: a keyword-anchored secret
 * (`PGPASSWORD=...`) loses its anchor word if the cut lands inside it, and a length-gated secret
 * (`ghp_...`) drops below its `{20,}` length gate if the cut shortens its random suffix. Either
 * way the value or token fragment survives in clear text. The fix is `redactedHighlight` (the
 * opposite order: `highlight(redact(raw), needle)`) — redact the full untruncated text first, so
 * every secret pattern is always matched intact before any cut can touch it.
 */
describe('redactedHighlight (Fix round 3: redact before truncating, not after)', () => {
  it('reproduces the keyword-anchored leak under the old (buggy) order — proves this is a real bug', () => {
    // 30 chars between the end of the secret and the matched needle — inside highlight()'s
    // default 40-char radius, so the secret is partially inside the truncation window.
    const secret = 'PGPASSWORD=hunter2';
    const raw = `filler ${secret}${' '.repeat(30)}target trailing filler text here`;
    const buggy = redact(highlight(raw, 'target')); // the OLD order this round fixes
    expect(buggy).toContain('hunter2'); // PGPASSWORD's anchor got bisected; the value survived
  });

  it('reproduces the length-gated leak under the old (buggy) order — proves this is a real bug', () => {
    // The secret sits AFTER the match this time: highlight()'s right-side (`end`) boundary
    // shortens the ghp_ token's random suffix below its regex's {20,} length gate.
    const secret = `ghp_${'a'.repeat(36)}`;
    const raw = `leading filler text here target${' '.repeat(30)}${secret} trailing`;
    const buggy = redact(highlight(raw, 'target'));
    // The gate-breaking fragment ("ghp_" + 1-19 chars, too short to match `{20,}`) survives in clear.
    expect(buggy).toMatch(/ghp_[A-Za-z0-9]{1,19}\b/);
  });

  it.each([30, 40, 50])(
    'keyword-anchored secret %i chars BEFORE the match never leaks under the fixed order',
    (gapLen) => {
      const secret = 'PGPASSWORD=hunter2';
      const raw = `filler ${secret}${' '.repeat(gapLen)}target trailing filler text here`;
      const out = redactedHighlight(raw, 'target');
      expect(out).not.toContain('hunter2');
    },
  );

  it('shows the full redaction tag when the whole secret sits inside the truncation window', () => {
    // A small gap keeps the entire (short, post-redaction) tag inside the ±40-char window, so
    // this asserts the positive case: not just "no leak" but "the tag is genuinely shown".
    const secret = 'PGPASSWORD=hunter2';
    const raw = `filler ${secret} target trailing filler text here`;
    const out = redactedHighlight(raw, 'target');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('«redacted:secret»');
    expect(out).toContain(`${SNIPPET_OPEN}target${SNIPPET_CLOSE}`);
  });

  it.each([30, 40, 50])(
    'keyword-anchored secret %i chars AFTER the match never leaks under the fixed order',
    (gapLen) => {
      const secret = 'PGPASSWORD=hunter2';
      const raw = `leading filler text here target${' '.repeat(gapLen)}${secret} trailing`;
      const out = redactedHighlight(raw, 'target');
      expect(out).not.toContain('hunter2');
    },
  );

  it.each([30, 40, 50])(
    'length-gated secret (ghp_...) %i chars BEFORE the match never leaks under the fixed order',
    (gapLen) => {
      const secret = `ghp_${'a'.repeat(36)}`;
      const raw = `filler ${secret}${' '.repeat(gapLen)}target trailing filler text here`;
      const out = redactedHighlight(raw, 'target');
      expect(out).not.toContain(secret);
      expect(out).not.toMatch(/ghp_[A-Za-z0-9]/); // no raw ghp_-prefixed fragment at all, tagged or absent
    },
  );

  it.each([30, 40, 50])(
    'length-gated secret (ghp_...) %i chars AFTER the match never leaks under the fixed order, even below its length gate',
    (gapLen) => {
      const secret = `ghp_${'a'.repeat(36)}`;
      const raw = `leading filler text here target${' '.repeat(gapLen)}${secret} trailing`;
      const out = redactedHighlight(raw, 'target');
      expect(out).not.toContain(secret);
      expect(out).not.toMatch(/ghp_[A-Za-z0-9]/);
    },
  );

  it('still wraps the matched token in snippet markers after redaction shifts offsets', () => {
    const secret = 'PGPASSWORD=hunter2';
    const raw = `filler ${secret} more filler target trailing text`;
    const out = redactedHighlight(raw, 'target');
    expect(out).toContain(`${SNIPPET_OPEN}target${SNIPPET_CLOSE}`);
    expect(out).not.toContain('hunter2');
  });

  it('a match that sits after a redacted span (secret precedes it in the text) still highlights the right token', () => {
    const secret = `ghp_${'b'.repeat(30)}`;
    const raw = `${secret} — investigating the failing target build`;
    const out = redactedHighlight(raw, 'target');
    expect(out).toContain(`${SNIPPET_OPEN}target${SNIPPET_CLOSE}`);
    expect(out).not.toContain(secret);
    expect(out).not.toMatch(/ghp_[A-Za-z0-9]/);
  });

  it('falls back to plain highlight() when there is nothing to redact', () => {
    expect(redactedHighlight('nothing sensitive here, just a target word', 'target')).toBe(
      highlight('nothing sensitive here, just a target word', 'target'),
    );
  });
});
