import { Button } from '@/components/ui/button.tsx';
import { type Theme, useThemeStore } from '@/stores/theme.ts';

const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const ICON: Record<Theme, string> = { system: '◐', light: '☀', dark: '☾' };

/** Cycles system → light → dark. `compact` shows the icon only (the label stays in `aria-label`). */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[NEXT[theme]]}`}
      title={`Theme: ${LABEL[theme]}`}
      onClick={() => setTheme(NEXT[theme])}
    >
      <span aria-hidden="true">{ICON[theme]}</span>
      {compact ? null : LABEL[theme]}
    </Button>
  );
}
