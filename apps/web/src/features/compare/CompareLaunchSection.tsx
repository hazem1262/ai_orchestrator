import type { CompareVariantInput } from '@orc/api-contract';
import { useCompareEstimate } from '@/api/queries/compare.ts';
import { Button } from '@/components/ui/button.tsx';
import { budgetWarning, formatEstimate, VARIANT_PRESETS } from './compare-model.ts';

const describeVariant = (v: CompareVariantInput) => `${v.source}${v.model ? ` · ${v.model}` : ''}`;

export function CompareLaunchSection({
  projectId,
  value,
  onChange,
}: {
  projectId: string | null;
  value: CompareVariantInput[];
  onChange(v: CompareVariantInput[]): void;
}) {
  const estimate = useCompareEstimate(projectId, value.length);
  const warning = value.length >= 2 && estimate.data ? budgetWarning(estimate.data) : null;
  return (
    <section className="mt-2 flex flex-col gap-2 text-sm" aria-label="Compare across agents">
      <p className="text-xs text-muted-foreground">
        Each variant runs the same prompt in its own new worktree, so a worktree (repo, base, slug) is
        required. Pick two or more.
      </p>
      <div className="flex flex-wrap gap-1">
        {VARIANT_PRESETS.map((p) => (
          <Button
            key={p.id}
            type="button"
            size="sm"
            variant="outline"
            aria-label={`Add ${p.label}`}
            onClick={() => onChange([...value, p.value])}
          >
            + {p.label}
          </Button>
        ))}
      </div>
      {value.length > 0 ? (
        <ol className="flex flex-col gap-1">
          {value.map((v, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: variants have no id and are numbered and removed by position
            <li key={`${i}-${describeVariant(v)}`} className="flex min-w-0 items-center gap-2">
              <span className="w-8 shrink-0 text-xs text-muted-foreground">v{i + 1}</span>
              <span className="min-w-0 truncate">{describeVariant(v)}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto"
                aria-label={`Remove v${i + 1}`}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
      {value.length >= 2 && estimate.data ? (
        <p className="font-medium">{formatEstimate(estimate.data)}</p>
      ) : null}
      {warning ? <p className="text-warning">{warning}</p> : null}
    </section>
  );
}
