/**
 * Recap data (outcomes, friction, per-skill run outcomes) stores its category keys as
 * snake_case, e.g. `fully_achieved` or `buggy_code`. This turns one into a sentence-case
 * label — `Fully achieved` — without a lookup table, since new categories can appear at
 * any time.
 */
export function humanizeLabel(key: string): string {
  const text = key.replace(/[_\s]+/g, ' ').trim();
  if (text.length === 0) return key;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
