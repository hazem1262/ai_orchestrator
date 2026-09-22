import type { OpenInApp } from '@orc/api-contract';
import type { Session } from '@orc/core';
import { useOpenIn } from '@/api/queries/launch.ts';
import { Button } from '@/components/ui/button.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { useLiveLayoutStore } from '@/stores/live-layout.ts';

const APP_LABEL: Record<OpenInApp, string> = {
  vscode: 'VS Code',
  terminal: 'Terminal',
  finder: 'Finder',
};

/** Split button: the action uses the app this project was last opened in. */
export function OpenInButton({ session }: { session: Session }) {
  const projectKey = session.projectId ?? '_none';
  const app = useLiveLayoutStore((s) => s.openInByProject[projectKey] ?? 'vscode');
  const setOpenIn = useLiveLayoutStore((s) => s.setOpenIn);
  const openIn = useOpenIn();
  return (
    <span className="inline-flex items-center gap-0.5">
      <Button
        size="sm"
        variant="outline"
        onClick={() => openIn.mutate({ source: session.source, id: session.id, app })}
      >
        {`Open in ${APP_LABEL[app]}`}
      </Button>
      <NativeSelect
        aria-label="Open in app"
        className="h-7 px-1 text-xs"
        value={app}
        onChange={(e) => setOpenIn(projectKey, e.target.value as OpenInApp)}
      >
        {(Object.keys(APP_LABEL) as OpenInApp[]).map((k) => (
          <option key={k} value={k}>
            {APP_LABEL[k]}
          </option>
        ))}
      </NativeSelect>
    </span>
  );
}
