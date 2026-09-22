import type { TestResult } from '@orc/core';
import { cn } from '@/components/ui/cn.ts';
import { testChipText } from './sort.ts';

export function TestChip({ result }: { result: TestResult | null }) {
  if (!result) return null;
  const failed = result.failed > 0;
  return (
    <span
      data-failed={failed ? 'true' : 'false'}
      title={result.command}
      className={cn(
        'rounded px-1.5 py-0.5 font-mono text-xs',
        failed ? 'bg-destructive text-primary-foreground' : 'bg-success/20 text-foreground',
      )}
    >
      {testChipText(result)}
    </span>
  );
}
