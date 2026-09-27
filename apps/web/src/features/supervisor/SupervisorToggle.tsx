import type { Session } from '@orc/core';
import { useId } from 'react';
import {
  useSetSupervisorTarget,
  useSupervisorStatus,
  useSupervisorTargets,
} from '@/api/queries/supervisor.ts';
import { Checkbox } from '@/components/ui/checkbox.tsx';

/**
 * The per-session switch in the session header. It renders only for sessions this app owns (the
 * supervisor never types into anything else). The box is the session's own target; with none set,
 * the session follows its project, which the note beside it names.
 */
export function SupervisorToggle({ session }: { session: Session }) {
  const owned = session.live?.ownership === 'owned' && !!session.live.ptyId;
  return owned ? <OwnedSupervisorToggle session={session} /> : null;
}

function OwnedSupervisorToggle({ session }: { session: Session }) {
  const status = useSupervisorStatus();
  const targets = useSupervisorTargets();
  const setTarget = useSetSupervisorTarget();
  const id = useId();
  if (status.error || targets.error) return null;
  const pk = `${session.source}:${session.id}`;
  const sessionTarget = targets.data?.find((t) => t.targetType === 'session' && t.targetId === pk);
  const projectTarget = session.projectId
    ? targets.data?.find((t) => t.targetType === 'project' && t.targetId === session.projectId)
    : undefined;
  const enabled = sessionTarget?.enabled ?? false;
  const followsProject = !sessionTarget && projectTarget?.enabled === true;
  const title =
    status.data && !status.data.enabled
      ? 'The supervisor is turned off in Settings'
      : 'The supervisor may answer routine, allow-listed questions in this session';

  return (
    <label className="flex items-center gap-1 text-xs" title={title} htmlFor={id}>
      <Checkbox
        id={id}
        aria-label="Supervisor for this session"
        checked={enabled}
        disabled={setTarget.isPending}
        onCheckedChange={(v) => setTarget.mutate({ targetType: 'session', targetId: pk, enabled: v })}
      />
      Supervisor
      {followsProject ? <span className="text-muted-foreground">(on for the project)</span> : null}
      {status.data && !status.data.enabled ? (
        <span className="text-muted-foreground">(off in Settings)</span>
      ) : null}
    </label>
  );
}
