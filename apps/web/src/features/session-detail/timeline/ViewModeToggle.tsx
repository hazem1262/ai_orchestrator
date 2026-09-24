import { useViewModeStore, type ViewMode } from '@/stores/view-mode.ts';

const MODES: Array<{ id: ViewMode; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'normal', label: 'Normal' },
  { id: 'verbose', label: 'Verbose' },
];

export function ViewModeToggle() {
  const mode = useViewModeStore((s) => s.mode);
  const setMode = useViewModeStore((s) => s.setMode);
  return (
    <div
      role="radiogroup"
      aria-label="View mode"
      className="inline-flex rounded border border-neutral-200 text-xs"
    >
      {MODES.map((m) => (
        <label
          key={m.id}
          className={`cursor-pointer px-2 py-1 has-[:focus-visible]:outline ${mode === m.id ? 'bg-neutral-900 text-white' : ''}`}
        >
          <input
            type="radio"
            name="orc-view-mode"
            value={m.id}
            checked={mode === m.id}
            onChange={() => setMode(m.id)}
            className="sr-only"
          />
          {m.label}
        </label>
      ))}
    </div>
  );
}
