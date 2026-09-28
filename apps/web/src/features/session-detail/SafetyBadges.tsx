import type { Source } from '@orc/core';
import { useSessionSafety } from '@/api/queries/session-detail.ts';
import { Badge } from '@/components/ui/badge.tsx';

const TONE: Record<string, string> = {
  bypass: 'bg-warning/15 text-warning',
  plan: 'bg-info/15 text-info',
  auto: 'bg-primary/15 text-primary',
  default: 'bg-muted text-foreground',
  custom: 'bg-accent text-accent-foreground',
  unknown: 'bg-muted text-muted-foreground',
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
