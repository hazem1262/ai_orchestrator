import { Button } from '@/components/ui/button.tsx';
import { HOOK_SNIPPET } from './format.ts';

export function HookSetup() {
  return (
    <section aria-label="Real-time hook" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Real-time hook (optional)</h2>
      <p className="text-sm text-muted-foreground">
        The Live board polls Claude's session registry every second. For faster "waiting" alerts, add these
        hooks to <code className="font-mono text-xs">~/.claude/settings.json</code> yourself — the app never
        edits that file.
      </p>
      <pre className="overflow-x-auto rounded-md border bg-muted p-2 font-mono text-xs">{HOOK_SNIPPET}</pre>
      <div>
        <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(HOOK_SNIPPET)}>
          Copy hook snippet
        </Button>
      </div>
    </section>
  );
}
