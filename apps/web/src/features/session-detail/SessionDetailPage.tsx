import type { Source } from '@orc/core';
import { useSession } from '@/api/queries/sessions.ts';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { AgncSessionPanel } from '@/features/agnc/AgncSessionPanel.tsx';
import { isRemoteSession } from '@/lib/source.ts';
import { DetailCrumbs } from './DetailCrumbs.tsx';
import { SessionHeader } from './SessionHeader.tsx';
import { SessionHeaderActions } from './SessionHeaderActions.tsx';
import { SessionWorkPanel } from './SessionWorkPanel.tsx';
import { type DetailNavigation, type DetailTab, SessionDetailTabs } from './tabs/SessionDetailTabs.tsx';

export interface SessionDetailPageProps {
  source: Source;
  id: string;
  tab: DetailTab;
  agentId: string | null;
  file: string | null;
  onNavigate: (n: DetailNavigation) => void;
}

const PAGE = 'mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-4 p-4 md:px-6';

export function SessionDetailPage({ source, id, tab, agentId, file, onNavigate }: SessionDetailPageProps) {
  const q = useSession(source, id);
  if (q.isLoading) {
    return (
      <div className={PAGE} aria-busy="true">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-2/3 max-w-xl" />
        <Skeleton className="h-28" />
        <Skeleton className="h-8 w-80 max-w-full" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className={PAGE}>
        <DetailCrumbs session={null} current={`${source}:${id}`} />
        <div className="flex items-center justify-between gap-3">
          <p role="alert" className="text-sm text-destructive">
            {q.error instanceof Error ? q.error.message : 'Session not found'}
          </p>
          <Button variant="outline" size="sm" disabled={q.isFetching} onClick={() => void q.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  const session = q.data;
  const title = session.name ?? session.firstPrompt ?? session.id;
  return (
    <div className={PAGE}>
      <DetailCrumbs session={session} current={title} />
      <SessionHeader session={session} actions={<SessionHeaderActions session={session} />} />
      {isRemoteSession(session) ? (
        <AgncSessionPanel session={session} />
      ) : (
        <>
          <SessionWorkPanel session={session} />
          <SessionDetailTabs
            session={session}
            tab={tab}
            agentId={agentId}
            file={file}
            onNavigate={onNavigate}
          />
        </>
      )}
    </div>
  );
}
