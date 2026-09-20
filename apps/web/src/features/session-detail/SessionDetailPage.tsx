import type { Source } from '@orc/core';
import { useSession } from '@/api/queries/sessions.ts';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { ResumeActions } from '@/features/terminal/ResumeActions.tsx';
import { SessionHeader } from './SessionHeader.tsx';
import { Timeline } from './Timeline.tsx';

export function SessionDetailPage({ source, id }: { source: Source; id: string }) {
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
    <div className="flex flex-col gap-4 p-4">
      <SessionHeader
        session={session}
        actions={
          <ResumeActions
            target={{
              source: session.source,
              id: session.id,
              availability: session.availability,
              live: session.live,
              title: session.name ?? session.firstPrompt ?? session.id,
            }}
          />
        }
      />
      <Tabs defaultValue="timeline">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="pt-3">
          <Timeline source={source} id={id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
