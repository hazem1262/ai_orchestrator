import { type BranchType, branchName } from '@orc/core/git';
import { type FormEvent, useId, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import { worktreeKeys } from '@/api/queries/worktrees.ts';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';
import { GitConfirmDialog } from '@/features/git/GitConfirmDialog.tsx';
import { GitDialog } from '@/features/git/GitDialog.tsx';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';
import { useTerminalStore } from '@/stores/terminals.ts';

const TYPES: readonly BranchType[] = ['feat', 'fix', 'chore', 'docs', 'refactor'];
const FIELD = 'flex flex-col gap-1 text-sm';

interface Vars {
  repo: string;
  base: string;
  type: BranchType;
  ticket: string | null;
  slug: string;
  runSetup: boolean;
  launch?: { source: 'claude' | 'codex'; prompt: string; planApproval: boolean };
}

export function CreateWorktreeDialog({
  repos,
  open,
  onClose,
}: {
  repos: string[];
  open: boolean;
  onClose: () => void;
}) {
  // Remounting per open is what resets the form.
  return open ? <CreateWorktreeForm repos={repos} onClose={onClose} /> : null;
}

function branchPreview(type: BranchType, ticket: string, slug: string): string {
  if (!slug.trim()) return '';
  try {
    return branchName({ type, ticket: ticket.trim() || null, slug });
  } catch (err) {
    return (err as Error).message;
  }
}

function CreateWorktreeForm({ repos, onClose }: { repos: string[]; onClose: () => void }) {
  const id = useId();
  const [repo, setRepo] = useState(repos[0] ?? '');
  const [base, setBase] = useState('main');
  const [type, setType] = useState<BranchType>('feat');
  const [ticket, setTicket] = useState('');
  const [slug, setSlug] = useState('');
  const [runSetup, setRunSetup] = useState(true);
  const [launch, setLaunch] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [planApproval, setPlanApproval] = useState(false);
  const openTerminal = useTerminalStore((s) => s.open);

  const m = useConfirmedMutation(
    (vars: Vars, confirm: boolean) => getApiClient().worktreesCreate({ ...vars, confirm }),
    {
      invalidate: [worktreeKeys.all],
      onSuccess: (r) => {
        if (r.setupPtyId) openTerminal(r.setupPtyId, `setup ${r.worktree.branch}`);
        if (r.launch) openTerminal(r.launch.ptyId, r.worktree.branch);
        onClose();
      },
    },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void m.run({
      repo,
      base,
      type,
      ticket: ticket.trim() || null,
      slug,
      runSetup,
      ...(launch ? { launch: { source: 'claude' as const, prompt, planApproval } } : {}),
    });
  };

  return (
    <>
      {!m.pending && (
        <GitDialog title="New worktree" onClose={onClose}>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className={FIELD}>
              <label htmlFor={`${id}-repo`}>Repository</label>
              {repos.length > 0 ? (
                <NativeSelect id={`${id}-repo`} value={repo} onChange={(e) => setRepo(e.target.value)}>
                  {repos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  id={`${id}-repo`}
                  value={repo}
                  placeholder="/path/to/repo"
                  onChange={(e) => setRepo(e.target.value)}
                />
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className={FIELD}>
                <label htmlFor={`${id}-base`}>Base branch</label>
                <Input id={`${id}-base`} value={base} onChange={(e) => setBase(e.target.value)} />
              </div>
              <div className={FIELD}>
                <label htmlFor={`${id}-type`}>Type</label>
                <NativeSelect
                  id={`${id}-type`}
                  value={type}
                  onChange={(e) => setType(e.target.value as BranchType)}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
            <div className={FIELD}>
              <label htmlFor={`${id}-ticket`}>Ticket</label>
              <Input
                id={`${id}-ticket`}
                value={ticket}
                placeholder="SAF-1787"
                onChange={(e) => setTicket(e.target.value)}
              />
            </div>
            <div className={FIELD}>
              <label htmlFor={`${id}-slug`}>Short description</label>
              <Input
                id={`${id}-slug`}
                value={slug}
                placeholder="exclude weekends sla"
                onChange={(e) => setSlug(e.target.value)}
              />
            </div>
            <output className="font-mono text-xs" aria-label="Branch preview">
              {branchPreview(type, ticket, slug)}
            </output>
            <div className="flex items-center gap-2 text-sm">
              <Checkbox id={`${id}-setup`} checked={runSetup} onCheckedChange={setRunSetup} />
              <label htmlFor={`${id}-setup`}>Run setup script</label>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Checkbox id={`${id}-launch`} checked={launch} onCheckedChange={setLaunch} />
              <label htmlFor={`${id}-launch`}>Launch Claude in the new worktree</label>
            </div>
            {launch && (
              <>
                <textarea
                  className="min-h-20 rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-primary"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  aria-label="Prompt"
                />
                <div className="flex items-center gap-2 text-sm">
                  <Checkbox id={`${id}-plan`} checked={planApproval} onCheckedChange={setPlanApproval} />
                  <label htmlFor={`${id}-plan`}>Require plan approval first</label>
                </div>
              </>
            )}
            {m.error && (
              <p role="alert" className="text-sm text-destructive">
                {m.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!repo || !slug.trim() || m.busy}>
                Create
              </Button>
            </div>
          </form>
        </GitDialog>
      )}
      <GitConfirmDialog
        request={m.pending}
        busy={m.busy}
        title="Create worktree?"
        confirmLabel="Create"
        onConfirm={(p) => void m.confirm(p)}
        onCancel={m.cancel}
      />
    </>
  );
}
