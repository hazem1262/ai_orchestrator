import type { Source } from '@orc/core';
import { Link } from '@tanstack/react-router';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb.tsx';

/** Back path for the review page (audit F15/F16): the session, then "Review". */
export function ReviewCrumbs({
  source,
  id,
  sessionTitle,
  current,
}: {
  source: Source;
  id: string;
  sessionTitle: string;
  current: string;
}) {
  return (
    <Breadcrumb>
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="min-w-0 shrink">
          <BreadcrumbLink asChild className="truncate">
            <Link to="/sessions/$source/$id" params={{ source, id }}>
              {sessionTitle}
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem className="min-w-0 shrink-0">
          <BreadcrumbPage className="truncate">{current}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
