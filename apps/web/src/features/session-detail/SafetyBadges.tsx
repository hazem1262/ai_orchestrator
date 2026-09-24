import type { Source } from '@orc/core';
import { useSessionSafety } from '@/api/queries/session-detail.ts';
import { Badge } from '@/components/ui/badge.tsx';

const TONE: Record<string, string> = {
  bypass: 'bg-amber-100 text-amber-900',
  plan: 'bg-sky-100 text-sky-900',
  auto: 'bg-violet-100 text-violet-900',
  default: 'bg-neutral-100 text-neutral-700',
  custom: 'bg-fuchsia-100 text-fuchsia-900',
  unknown: 'bg-neutral-100 text-neutral-500',
};

export function SafetyBadges({ source, id }: { source: Source; id: string }) {
  const q = useSessionSafety(source, id);
  const s = q.data;
  if (!s) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <Badge
        variant="outline"
        title={`permission mode: ${s.permissionMode ?? 'unknown'}`}
        className={`border-transparent ${TONE[s.permissionBadge] ?? ''}`}
      >
        {s.permissionBadge}
      </Badge>
      {s.touchedProd && (
        <Badge
          variant="destructive"
          title={s.prodTouches.map((t) => `${t.kind}: ${t.detail}`).join('\n') || 'flagged by the indexer'}
          className="font-semibold"
        >
          {`PROD ×${s.prodTouches.length}`}
        </Badge>
      )}
    </span>
  );
}
