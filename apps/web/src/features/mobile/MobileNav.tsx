import { Link } from '@tanstack/react-router';
import { MenuIcon } from 'lucide-react';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet.tsx';

const ITEMS = [
  { to: '/inbox', label: 'Inbox' },
  { to: '/live', label: 'Live' },
  { to: '/settings', label: 'Settings' },
] as const;

/** Every top-level section, the same set the desktop sidebar (`nav[aria-label=Main]`) links to. */
const SECTIONS = [
  { to: '/inbox', label: 'Inbox' },
  { to: '/live', label: 'Live' },
  { to: '/worktrees', label: 'Worktrees' },
  { to: '/history', label: 'History' },
  { to: '/settings', label: 'Settings' },
  { to: '/audit', label: 'Audit' },
  { to: '/streams', label: 'Streams' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/automations', label: 'Automations' },
] as const;

function MoreSheet() {
  return (
    <Sheet>
      <SheetTrigger className="flex flex-1 items-center justify-center gap-1 py-3 text-sm">
        <MenuIcon aria-hidden className="size-4" />
        More
      </SheetTrigger>
      <SheetContent side="bottom" aria-describedby={undefined} className="pb-[env(safe-area-inset-bottom)]">
        <SheetHeader className="pb-0">
          <SheetTitle>All sections</SheetTitle>
        </SheetHeader>
        <nav aria-label="All sections" className="grid grid-cols-2 gap-1 px-2 pb-4 text-sm">
          {SECTIONS.map((s) => (
            <SheetClose key={s.to} asChild>
              <Link
                to={s.to}
                className="rounded-md px-3 py-3 hover:bg-muted"
                activeProps={{ className: 'bg-muted font-semibold text-primary' }}
              >
                {s.label}
              </Link>
            </SheetClose>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}

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
      <MoreSheet />
    </nav>
  );
}
