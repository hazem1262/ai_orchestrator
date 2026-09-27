import type { NotifyChannel, NotifyPref } from './notifier.ts';

/** A disabled pref sends nothing. While away, `macos` is dropped and the away channels are added. */
export function selectChannels(i: {
  pref: NotifyPref;
  away: boolean;
  awayChannels: NotifyChannel[];
}): NotifyChannel[] {
  if (!i.pref.enabled) return [];
  const out = new Set<NotifyChannel>(i.pref.channels);
  if (i.away) {
    out.delete('macos');
    for (const c of i.awayChannels) out.add(c);
  }
  return [...out];
}
