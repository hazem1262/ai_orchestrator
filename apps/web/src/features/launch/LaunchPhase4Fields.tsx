import type { LaunchRequest } from '@orc/api-contract';
import { type BranchType, branchName } from '@orc/core/git';
import { useId } from 'react';
import type { z } from 'zod';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect } from '@/components/ui/native-select.tsx';

export type LaunchDraft = z.input<typeof LaunchRequest>;

const TYPES: readonly BranchType[] = ['feat', 'fix', 'chore', 'docs', 'refactor'];

function branchPreview(type: BranchType, ticket: string | undefined, slug: string): string {
  if (!slug.trim()) return '';
  try {
    return branchName({ type, ticket: ticket?.trim() || null, slug });
  } catch (err) {
    return (err as Error).message;
  }
}

export function LaunchPhase4Fields({
  draft,
  onChange,
  repos,
}: {
  draft: LaunchDraft;
  onChange(d: LaunchDraft): void;
  repos: string[];
}) {
  const id = useId();
  const wt = draft.worktree;
  const setWt = (patch: Partial<NonNullable<LaunchDraft['worktree']>>) =>
    onChange({
      ...draft,
      worktree: { repo: repos[0] ?? '', base: 'main', type: 'feat', slug: '', ...wt, ...patch },
    });
  const preview = wt ? branchPreview(wt.type, draft.ticket, wt.slug) : '';
  return (
    <fieldset className="flex flex-col gap-2 text-sm">
      <legend className="sr-only">Plan approval and worktree</legend>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-plan`}
          disabled={draft.source !== 'claude'}
          checked={draft.planApproval ?? false}
          onCheckedChange={(v) => onChange({ ...draft, planApproval: v })}
        />
        <label htmlFor={`${id}-plan`}>Require plan approval first</label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-wt`}
          checked={wt !== undefined}
          onCheckedChange={(v) => {
            if (v) setWt({});
            else {
              const { worktree: _drop, ...rest } = draft;
              onChange(rest);
            }
          }}
        />
        <label htmlFor={`${id}-wt`}>New worktree for this ticket</label>
      </div>
      {wt && (
        <div className="grid grid-cols-2 gap-2">
          <NativeSelect
            aria-label="Worktree repository"
            value={wt.repo}
            onChange={(e) => setWt({ repo: e.target.value })}
          >
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </NativeSelect>
          <Input
            aria-label="Worktree base"
            value={wt.base}
            onChange={(e) => setWt({ base: e.target.value })}
          />
          <NativeSelect
            aria-label="Worktree type"
            value={wt.type}
            onChange={(e) => setWt({ type: e.target.value as BranchType })}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </NativeSelect>
          <Input
            aria-label="Worktree description"
            value={wt.slug}
            onChange={(e) => setWt({ slug: e.target.value })}
          />
          <p className="col-span-2 font-mono text-xs">{preview}</p>
        </div>
      )}
    </fieldset>
  );
}
