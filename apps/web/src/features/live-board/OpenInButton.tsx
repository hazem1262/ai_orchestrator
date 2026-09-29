import type { OpenInApp } from '@orc/api-contract';
import type { Session } from '@orc/core';
import { ChevronDown } from 'lucide-react';
import { useOpenIn } from '@/api/queries/launch.ts';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { useLiveLayoutStore } from '@/stores/live-layout.ts';

const APP_LABEL: Record<OpenInApp, string> = {
  vscode: 'VS Code',
  terminal: 'Terminal',
  finder: 'Finder',
};

/** Split button: the action uses the app this project was last opened in; the chevron picks another. */
export function OpenInButton({ session }: { session: Session }) {
  const projectKey = session.projectId ?? '_none';
  const app = useLiveLayoutStore((s) => s.openInByProject[projectKey] ?? 'vscode');
  const setOpenIn = useLiveLayoutStore((s) => s.setOpenIn);
  const openIn = useOpenIn();
  return (
    <span className="inline-flex items-center">
      <Button
        size="sm"
        variant="outline"
        className="rounded-r-none"
        onClick={() => openIn.mutate({ source: session.source, id: session.id, app })}
      >
        {`Open in ${APP_LABEL[app]}`}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="outline" className="-ml-px rounded-l-none" aria-label="Open in app">
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuLabel>Open in</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={app} onValueChange={(v) => setOpenIn(projectKey, v as OpenInApp)}>
            {(Object.keys(APP_LABEL) as OpenInApp[]).map((k) => (
              <DropdownMenuRadioItem key={k} value={k}>
                {APP_LABEL[k]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
