import type { Session } from '@orc/core';
import { ChevronRight } from 'lucide-react';
import { GoalEditor } from '../goals/GoalEditor.tsx';
import { HandoffPanel } from '../handoffs/HandoffPanel.tsx';
import { RecapPanel } from '../recaps/RecapPanel.tsx';
import { ReminderPanel } from '../reminders/ReminderPanel.tsx';

/**
 * Goal, reminders, recap and handoff for the session (F14, F16, F19), folded under the facts strip
 * so the header keeps one row of actions. The panels stay mounted while folded.
 */
export function SessionWorkPanel({ session }: { session: Session }) {
  const pk = `${session.source}:${session.id}`;
  return (
    <details className="group rounded-lg border">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium hover:bg-muted/50">
        <ChevronRight
          aria-hidden
          className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
        />
        Goal, reminders, recap and handoff
      </summary>
      <div className="grid gap-4 border-t p-3 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <GoalEditor targetType="session" targetId={pk} />
          <ReminderPanel
            sessionPk={pk}
            ticket={session.tickets[0] ?? null}
            owned={session.live?.ownership === 'owned'}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <RecapPanel source={session.source} id={session.id} />
          <HandoffPanel source={session.source} id={session.id} />
        </div>
      </div>
    </details>
  );
}
