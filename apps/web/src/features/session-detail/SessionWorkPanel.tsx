import type { Session } from '@orc/core';
import { GoalEditor } from '../goals/GoalEditor.tsx';
import { HandoffPanel } from '../handoffs/HandoffPanel.tsx';
import { ContextFillBadge } from '../limits/ContextFillBadge.tsx';
import { RecapPanel } from '../recaps/RecapPanel.tsx';
import { ReminderPanel } from '../reminders/ReminderPanel.tsx';

/** Phase 5 work panel under the session header: goal, recap, handoff and reminders (F14, F16, F19). */
export function SessionWorkPanel({ session }: { session: Session }) {
  const pk = `${session.source}:${session.id}`;
  return (
    <div className="grid gap-4 rounded-md border p-3 md:grid-cols-2">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ContextFillBadge source={session.source} id={session.id} />
        </div>
        <GoalEditor targetType="session" targetId={pk} />
        <ReminderPanel
          sessionPk={pk}
          ticket={session.tickets[0] ?? null}
          owned={session.live?.ownership === 'owned'}
        />
      </div>
      <div className="flex flex-col gap-3">
        <RecapPanel source={session.source} id={session.id} />
        <HandoffPanel source={session.source} id={session.id} />
      </div>
    </div>
  );
}
