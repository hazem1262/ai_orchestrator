import type { Source } from '@orc/core';
import { useSession } from '@/api/queries/sessions.ts';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { ResumeActions } from '@/features/terminal/ResumeActions.tsx';
import { ExportButton } from './ExportButton.tsx';
import { SafetyBadges } from './SafetyBadges.tsx';
import { SessionHeader } from './SessionHeader.tsx';
import { type DetailNavigation, type DetailTab, SessionDetailTabs } from './tabs/SessionDetailTabs.tsx';
import { ViewModeToggle } from './timeline/ViewModeToggle.tsx';

export interface SessionDetailPageProps {
  source: Source;
  id: string;
  tab: DetailTab;
  agentId: string | null;
  file: string | null;
  onNavigate: (n: DetailNavigation) => void;
}

export function SessionDetailPage({ source, id, tab, agentId, file, onNavigate }: SessionDetailPageProps) {
  const q = useSession(source, id);
  if (q.isLoading) {
    return (
      <div className="p-4">
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="flex items-center justify-between gap-3 p-4">
        <p role="alert" className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : 'Session not found'}
        </p>
        <Button variant="outline" size="sm" disabled={q.isFetching} onClick={() => void q.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const session = q.data;
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <SessionHeader
        session={session}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <SafetyBadges source={source} id={id} />
            <ViewModeToggle />
            <a
              href={`/audit?sessionPk=${encodeURIComponent(`${source}:${id}`)}`}
              className="text-xs text-primary underline"
            >
              Audit
            </a>
            <ExportButton source={source} id={id} />
            <ResumeActions
              target={{
                source: session.source,
                id: session.id,
                availability: session.availability,
                live: session.live,
                title: session.name ?? session.firstPrompt ?? session.id,
              }}
            />
          </div>
        }
      />
      <SessionDetailTabs session={session} tab={tab} agentId={agentId} file={file} onNavigate={onNavigate} />
    </div>
  );
}
