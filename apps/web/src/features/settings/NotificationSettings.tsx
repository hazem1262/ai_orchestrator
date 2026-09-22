import type { NotificationPrefs } from '@orc/api-contract';
import { useEffect, useState } from 'react';
import { useNotificationPrefs, useSaveNotificationPrefs } from '@/api/queries/archive.ts';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { NOTIFY_KINDS } from './format.ts';

type Pref = NotificationPrefs[string];

const OFF: Pref = { enabled: false, channels: [] };

export function NotificationSettings() {
  const { data } = useNotificationPrefs();
  const save = useSaveNotificationPrefs();
  const [draft, setDraft] = useState<NotificationPrefs>({});
  // The server value is the starting point; local edits survive until the next server change.
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const pref = (kind: string): Pref => draft[kind] ?? OFF;
  // Turning a kind on with no channel left would be a notification that goes nowhere, so macOS
  // comes back with it.
  const setEnabled = (kind: string, enabled: boolean) => {
    const p = pref(kind);
    const channels = enabled && p.channels.length === 0 ? (['macos'] as const) : p.channels;
    setDraft({ ...draft, [kind]: { enabled, channels: [...channels] } });
  };
  const setMacos = (kind: string, on: boolean) => {
    const p = pref(kind);
    const channels = on
      ? [...new Set<Pref['channels'][number]>([...p.channels, 'macos'])]
      : p.channels.filter((c) => c !== 'macos');
    setDraft({ ...draft, [kind]: { ...p, channels } });
  };

  return (
    <section aria-label="Notifications" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Notifications</h2>
      <p className="text-sm text-muted-foreground">
        One notification per session per state change. Web push and Slack DM arrive in Phase 6.
      </p>
      {/* Every box would read "off" until the prefs land, and a click in that window would be
          saved over the real value. */}
      {data === undefined ? <Skeleton className="h-64 max-w-md" /> : null}
      <table hidden={data === undefined} className="w-full max-w-md text-sm">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-medium">Item type</th>
            <th className="font-medium">On</th>
            <th className="font-medium">macOS</th>
          </tr>
        </thead>
        <tbody>
          {NOTIFY_KINDS.map(({ kind, label }) => {
            const p = pref(kind);
            return (
              <tr key={kind}>
                <td className="py-0.5">{label}</td>
                <td className="text-center">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    aria-label={`${label}: enabled`}
                    checked={p.enabled}
                    onChange={(e) => setEnabled(kind, e.target.checked)}
                  />
                </td>
                <td className="text-center">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    aria-label={`${label}: macOS`}
                    checked={p.channels.includes('macos')}
                    disabled={!p.enabled}
                    onChange={(e) => setMacos(kind, e.target.checked)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>
          Save notifications
        </Button>
        {save.isSuccess ? <span className="text-sm text-muted-foreground">Saved.</span> : null}
        {save.error ? (
          <span role="alert" className="text-sm text-destructive">
            {save.error.message}
          </span>
        ) : null}
      </div>
    </section>
  );
}
