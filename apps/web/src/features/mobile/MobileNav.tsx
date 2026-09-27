import { Link } from '@tanstack/react-router';

const ITEMS = [
  { to: '/inbox', label: 'Inbox' },
  { to: '/live', label: 'Live' },
  { to: '/settings', label: 'Settings' },
] as const;

export function MobileNav() {
  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t bg-background pb-[env(safe-area-inset-bottom)]"
    >
      {ITEMS.map((i) => (
        <Link
          key={i.to}
          to={i.to}
          className="flex-1 py-3 text-center text-sm"
          activeProps={{ className: 'font-semibold text-primary' }}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
