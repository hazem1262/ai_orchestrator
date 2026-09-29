import { SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty.tsx';

/**
 * The app-wide 404, wired from `router.tsx`'s `defaultNotFoundComponent`. TanStack Router's
 * default ignore prefix (`-`) keeps this file out of the generated route tree even though it
 * lives in `routes/`.
 */
export function NotFoundPage() {
  return (
    <div className="flex min-w-0 flex-col p-4">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX />
          </EmptyMedia>
          <EmptyTitle>Page not found</EmptyTitle>
          <EmptyDescription>
            There is nothing here. The link may be old, or the page may have moved.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" asChild>
            <a href="/live">Go to Live</a>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
