import type { Source } from '@orc/core';
import { useContextFill } from '@/api/queries/usage.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { formatPctValue } from './format.ts';

/** Context-window fill for one session, with the "resume fresh" hint near the limit (F19). */
export function ContextFillBadge({
  source,
  id,
  onResumeFresh,
}: {
  source: Source;
  id: string;
  onResumeFresh?: () => void;
}) {
  const { data } = useContextFill(source, id);
  if (!data) return null;
  return (
    <span
      className="flex items-center gap-1 text-xs"
      title={`${data.usedTokens.toLocaleString('en-US')} of ${data.windowTokens.toLocaleString('en-US')} tokens`}
    >
      <Badge variant={data.warn ? 'destructive' : 'outline'}>ctx {formatPctValue(data.fill)}</Badge>
      {data.warn ? (
        onResumeFresh ? (
          <Button size="sm" variant="ghost" className="text-warning" onClick={onResumeFresh}>
            near the limit — resume fresh with a handoff
          </Button>
        ) : (
          <span className="text-warning">near the limit — resume fresh with a handoff</span>
        )
      ) : null}
    </span>
  );
}
