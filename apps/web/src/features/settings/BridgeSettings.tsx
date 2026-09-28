import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useHookStatus, useInstallHooks, useStatuslineSnippet } from '@/api/queries/settings.ts';
import { Alert, AlertDescription } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { SettingsCard } from './SettingsCard.tsx';

export function BridgeSettings() {
  const status = useHookStatus();
  const install = useInstallHooks();
  const statusline = useStatuslineSnippet();
  const [confirming, setConfirming] = useState(false);
  const s = status.data;

  return (
    <SettingsCard
      label="Real-time bridge"
      title="Real-time bridge (optional)"
      description="Claude Code hooks push SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification and Stop events to the daemon on 127.0.0.1, which makes status changes appear in well under a second. Without them the app polls files instead."
    >
      {s ? (
        <>
          <p className="flex flex-wrap items-center gap-2">
            Settings file: <code className="min-w-0 break-all font-mono text-xs">{s.settingsPath}</code>
            {s.installed ? (
              <Badge variant="success">installed</Badge>
            ) : (
              <Badge variant="outline">not installed</Badge>
            )}
          </p>
          {s.installed ? <p className="text-success">Hooks are installed.</p> : null}
          <p className="text-muted-foreground">
            {s.settingsExists
              ? 'Installing merges these hook entries into the settings file. Other keys are kept:'
              : 'Installing creates the settings file with these hook entries:'}
          </p>
          <pre className="max-h-60 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs">
            {s.snippet}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigator.clipboard?.writeText(s.snippet)}
            >
              Copy snippet
            </Button>
            {confirming ? (
              <>
                <Button
                  size="sm"
                  disabled={install.isPending}
                  onClick={() => install.mutate(undefined, { onSuccess: () => setConfirming(false) })}
                >
                  Confirm — write settings.json
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setConfirming(true)}>
                {s.installed ? 'Reinstall hooks…' : 'Install hooks…'}
              </Button>
            )}
          </div>
          {confirming ? (
            <Alert role="status" className="border-warning/40 bg-warning/10">
              <TriangleAlert aria-hidden className="text-warning" />
              <AlertDescription className="text-pretty text-foreground">
                {`This writes ${s.settingsPath}, the only file the app writes inside ~/.claude. A backup is saved to ${s.backupDir} first, and the change is recorded in the audit log.`}
              </AlertDescription>
            </Alert>
          ) : null}
          {install.isSuccess ? (
            <p className="text-success">
              {`Installed. Backup written to ${install.data.backupPath ?? '(no previous file)'}.`}
            </p>
          ) : null}
          {install.isError ? (
            <p role="alert" className="text-destructive">
              Could not write settings.json. Check that it is valid JSON.
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground">Loading…</p>
      )}
      <Separator />
      <h3 className="font-semibold">Statusline (optional)</h3>
      <p className="text-muted-foreground">
        Shows session cost, context fill, the current 5-hour block and the number of waiting sessions in
        Claude's statusline. The app never writes this — copy it and add it to ~/.claude/settings.json
        yourself.
      </p>
      <pre className="overflow-auto rounded-md border bg-muted p-2 font-mono text-xs">
        {statusline.data?.snippet ?? ''}
      </pre>
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void navigator.clipboard?.writeText(statusline.data?.snippet ?? '')}
        >
          Copy statusline snippet
        </Button>
      </div>
    </SettingsCard>
  );
}
