import type { TestResult } from '@orc/core';
import { FlaskConical } from 'lucide-react';
import { cn } from '@/components/ui/cn.ts';
import { testChipText } from './sort.ts';
import { SOFT } from './status.tsx';

export function TestChip({ result }: { result: TestResult | null }) {
  if (!result) return null;
  const failed = result.failed > 0;
  return (
    <span
      data-failed={failed ? 'true' : 'false'}
      title={result.command}
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-sm px-1.5 font-mono text-xs font-medium',
        failed ? SOFT.danger : SOFT.success,
      )}
    >
      <FlaskConical className="size-3" aria-hidden />
      <span>{testChipText(result)}</span>
    </span>
  );
}
