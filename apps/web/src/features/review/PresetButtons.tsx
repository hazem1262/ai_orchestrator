import type { ReviewSummary } from '@orc/core';
import { getApiClient } from '@/api/client.ts';
import { Button } from '@/components/ui/button.tsx';
import { useTerminalStore } from '@/stores/terminals.ts';

export async function launchPreset(
  presetId: string,
  i: { cwd: string; projectId: string | null; vars: Record<string, string> },
): Promise<{ ptyId: string }> {
  const r = await getApiClient().sessionsLaunch({
    source: 'claude',
    projectId: i.projectId,
    cwd: i.cwd,
    prompt: '',
    templateId: presetId,
    vars: i.vars,
    planApproval: false,
  });
  useTerminalStore.getState().open(r.ptyId, presetId.replace('preset-', ''));
  return { ptyId: r.ptyId };
}

export function PresetButtons({ summary: s }: { summary: ReviewSummary }) {
  const pr = s.pr;
  if (pr?.state !== 'open') return null;
  const ticket: Record<string, string> = s.worktree?.ticket ? { ticket: s.worktree.ticket } : {};
  const projectId = s.worktree?.projectId ?? null;
  const fixCi = { prUrl: pr.pr.url, check: pr.failedChecks[0] ?? '', ...ticket };
  const address = { prUrl: pr.pr.url, ...ticket };
  return (
    <div className="flex gap-1">
      {pr.checks === 'failure' && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void launchPreset('preset-fix-ci', { cwd: s.cwd, projectId, vars: fixCi })}
        >
          Fix CI
        </Button>
      )}
      {pr.review === 'changes_requested' && (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void launchPreset('preset-address-comments', { cwd: s.cwd, projectId, vars: address })
          }
        >
          Address comments
        </Button>
      )}
    </div>
  );
}
