import type { Source } from '@orc/core';
import { useArchiveRestore } from '@/api/queries/archive.ts';
import { Button } from '@/components/ui/button.tsx';
import { describeLaunchError } from '@/features/launch/LaunchDialog.tsx';

/** Restoring writes into `~/.claude/projects`, the one place the app ever writes outside its own
 *  home, so the browser asks first and the daemon refuses to overwrite anything that is there. */
export function RestoreButton({ source, id }: { source: Source; id: string }) {
  const restore = useArchiveRestore();
  const onClick = () => {
    const ok = window.confirm(
      `Restore the archived transcript for ${id} into ~/.claude/projects? Existing files are never overwritten.`,
    );
    if (ok) restore.mutate({ source, id });
  };
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={restore.isPending} onClick={onClick}>
        Restore transcript
      </Button>
      {restore.data ? (
        <span className="text-sm text-muted-foreground">
          {`Restored ${restore.data.restored.length} file(s). The session can be resumed now.`}
        </span>
      ) : null}
      {restore.error ? (
        <span role="alert" className="text-sm text-destructive">
          {describeLaunchError(restore.error)}
        </span>
      ) : null}
    </span>
  );
}
