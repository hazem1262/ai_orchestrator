export type PermissionBadge = 'bypass' | 'plan' | 'auto' | 'default' | 'custom' | 'unknown';
type Known = Exclude<PermissionBadge, 'custom' | 'unknown'>;

const KNOWN: Record<string, Known> = {
  // Claude Code
  bypassPermissions: 'bypass',
  plan: 'plan',
  acceptEdits: 'auto',
  auto: 'auto',
  default: 'default',
  // Codex approval policies
  never: 'bypass',
  'on-failure': 'auto',
  'on-request': 'default',
  untrusted: 'default',
};

/**
 * Badge for the permission modes seen in a session.
 * Plan → X and default → X are normal transitions, so the badge is X.
 * An unknown mode, or two distinct non-plan/default modes, is 'custom'.
 */
export function permissionBadge(modes: readonly (string | null | undefined)[]): PermissionBadge {
  const distinct = [...new Set(modes.filter((m): m is string => typeof m === 'string' && m.length > 0))];
  if (distinct.length === 0) return 'unknown';
  const mapped: Known[] = [];
  for (const m of distinct) {
    const k = KNOWN[m];
    if (k === undefined) return 'custom';
    mapped.push(k);
  }
  const set = new Set(mapped);
  if (set.size === 1) return mapped[0] ?? 'unknown';
  set.delete('plan');
  if (set.size === 1) return [...set][0] ?? 'unknown';
  set.delete('default');
  if (set.size === 0) return 'default';
  if (set.size === 1) return [...set][0] ?? 'unknown';
  return 'custom';
}
