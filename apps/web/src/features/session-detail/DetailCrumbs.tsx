import type { Session } from '@orc/core';
import { Link } from '@tanstack/react-router';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb.tsx';

/** A running session belongs to the Live board; everything else is found through History. */
export function crumbParent(session: Pick<Session, 'live'> | null): {
  label: string;
  to: '/live' | '/history';
} {
  return session?.live && session.live.status !== 'ended'
    ? { label: 'Live', to: '/live' }
    : { label: 'History', to: '/history' };
}

/** Back path for the session page (audit F15): `History / <title>` or `Live / <title>`. */
export function DetailCrumbs({ session, current }: { session: Session | null; current: string }) {
  const parent = crumbParent(session);
  return (
    <Breadcrumb>
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="shrink-0">
          <BreadcrumbLink asChild>
            <Link to={parent.to}>{parent.label}</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="truncate">{current}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
