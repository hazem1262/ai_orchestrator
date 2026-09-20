import { Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Input } from '@/components/ui/input.tsx';
import { ProjectSelector } from './ProjectSelector.tsx';

function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void navigate({ to: '/history', search: q.trim() ? { q: q.trim() } : {} });
  };
  return (
    <form onSubmit={submit} className="w-72">
      <Input
        type="search"
        aria-label="Search all sessions"
        placeholder="Search sessions…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="w-full"
      />
    </form>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b px-4">
        <Link to="/history" className="font-semibold">
          Orchestrator
        </Link>
        <ProjectSelector />
        <GlobalSearch />
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Main" className="flex w-40 shrink-0 flex-col gap-1 border-r p-2 text-sm">
          <Link
            to="/history"
            className="rounded px-2 py-1 hover:bg-muted"
            activeProps={{ className: 'bg-muted font-medium' }}
          >
            History
          </Link>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-h-0 flex-1 overflow-auto">{children}</main>
        </div>
      </div>
    </div>
  );
}
