import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge.tsx';

export function InboxCount({ count }: { count: number }) {
  return (
    <Link
      to="/inbox"
      aria-label={`Inbox, ${count} open`}
      className="inline-flex items-center gap-1 text-sm hover:underline"
    >
      <span aria-hidden="true">Inbox</span>
      {count > 0 ? <Badge variant="destructive">{count}</Badge> : null}
    </Link>
  );
}
