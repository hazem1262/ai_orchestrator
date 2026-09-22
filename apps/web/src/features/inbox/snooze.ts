/** The three snooze offers every inbox row shares, resolved against a caller-supplied clock. */
export function snoozePresets(now: Date): Array<{ label: string; until: string }> {
  const hour = new Date(now.getTime() + 3_600_000);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now);
  // `8 - day` lands on next week's Monday; `|| 7` keeps a Monday from snoozing to itself.
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  return [
    { label: '1 hour', until: hour.toISOString() },
    { label: 'Tomorrow 9:00', until: tomorrow.toISOString() },
    { label: 'Next Monday 9:00', until: monday.toISOString() },
  ];
}
