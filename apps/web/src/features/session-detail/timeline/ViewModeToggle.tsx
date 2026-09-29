import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { useViewModeStore, type ViewMode } from '@/stores/view-mode.ts';

const MODES: Array<{ id: ViewMode; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'normal', label: 'Normal' },
  { id: 'verbose', label: 'Verbose' },
];

const isViewMode = (v: string): v is ViewMode => MODES.some((m) => m.id === v);

export function ViewModeToggle() {
  const mode = useViewModeStore((s) => s.mode);
  const setMode = useViewModeStore((s) => s.setMode);
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      role="radiogroup"
      aria-label="View mode"
      value={mode}
      onValueChange={(v) => {
        if (isViewMode(v)) setMode(v);
      }}
    >
      {MODES.map((m) => (
        <ToggleGroupItem key={m.id} value={m.id}>
          {m.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
