import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { DEFAULT_PROJECT_ID, useProjectStore } from '@/stores/project.ts';
import { ShareDialog } from './ShareDialog.tsx';

/** `d` as YYYY-MM-DD in local time. */
export function todayLocal(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function DailyUpdateButton() {
  const projectId = useProjectStore((s) => s.projectId);
  const [open, setOpen] = useState(false);
  const target = projectId && projectId !== 'all' ? projectId : DEFAULT_PROJECT_ID;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Post daily update
      </Button>
      {open ? (
        <ShareDialog
          title={`Daily update — ${target}`}
          target={{ kind: 'slack-post' }}
          source={{ kind: 'daily', projectId: target, date: todayLocal() }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
