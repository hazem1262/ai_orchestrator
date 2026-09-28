import type { NotificationPrefs } from '@orc/api-contract';
import { useState } from 'react';
import { useNotificationPrefs, useSaveNotificationPrefs } from '@/api/queries/archive.ts';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { NOTIFY_KINDS } from './format.ts';
import { SettingsCard } from './SettingsCard.tsx';

type Pref = NotificationPrefs[string];

const OFF: Pref = { enabled: false, channels: [] };

export function NotificationSettings() {
  const { data } = useNotificationPrefs();
  const save = useSaveNotificationPrefs();
  const [draft, setDraft] = useState<NotificationPrefs>(data ?? {});
  // The server value is the starting point; local edits survive until the next server change.
  // The draft is copied during render, not in an effect, so the commit that reveals the table
  // already holds the saved prefs.
  const [synced, setSynced] = useState(data);
  if (data !== synced) {
    setSynced(data);
    if (data) setDraft(data);
  }

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
    <SettingsCard
      label="Notifications"
      title="Notifications"
      description="One notification per session per state change. Web push and Slack DM arrive in Phase 6."
    >
      {/* Every box would read "off" until the prefs land, and a click in that window would be
          saved over the real value. */}
      {data === undefined ? <Skeleton className="h-64 max-w-md" /> : null}
      <Table hidden={data === undefined} className="max-w-md">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="text-muted-foreground">Item type</TableHead>
            <TableHead className="w-16 text-center text-muted-foreground">On</TableHead>
            <TableHead className="w-16 text-center text-muted-foreground">macOS</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {NOTIFY_KINDS.map(({ kind, label }) => {
            const p = pref(kind);
            return (
              <TableRow key={kind}>
                <TableCell className="whitespace-normal">{label}</TableCell>
                <TableCell>
                  <Checkbox
                    className="mx-auto"
                    aria-label={`${label}: enabled`}
                    checked={p.enabled}
                    onCheckedChange={(v) => setEnabled(kind, v)}
                  />
                </TableCell>
                <TableCell>
                  <Checkbox
                    className="mx-auto"
                    aria-label={`${label}: macOS`}
                    checked={p.channels.includes('macos')}
                    disabled={!p.enabled}
                    onCheckedChange={(v) => setMacos(kind, v)}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <div className="flex items-center gap-2 border-t pt-4">
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
    </SettingsCard>
  );
}
