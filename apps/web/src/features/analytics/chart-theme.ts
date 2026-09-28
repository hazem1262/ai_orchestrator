import { useEffect, useState } from 'react';

/** The subset of the Calm design tokens a chart needs, read straight off `<html>`. */
export interface ChartTheme {
  colors: [string, string, string, string, string];
  foreground: string;
  mutedForeground: string;
  border: string;
}

const FALLBACK: ChartTheme = {
  colors: ['#6d5efc', '#2dabc4', '#1f9d63', '#c98a1a', '#c74a3c'],
  foreground: '#1f2430',
  mutedForeground: '#6b7280',
  border: '#e5e7eb',
};

function tokenOrFallback(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/**
 * Reads `--chart-1..5`, `--foreground`, `--muted-foreground` and `--border` off
 * `document.documentElement` so a chart's colours always match the Calm tokens for whichever
 * theme is active (the app toggles a `dark` class on `<html>`, see `useChartTheme`).
 */
export function readChartTheme(): ChartTheme {
  if (typeof document === 'undefined') return FALLBACK;
  const styles = getComputedStyle(document.documentElement);
  return {
    colors: [1, 2, 3, 4, 5].map((n) =>
      tokenOrFallback(styles, `--chart-${n}`, FALLBACK.colors[n - 1] as string),
    ) as ChartTheme['colors'],
    foreground: tokenOrFallback(styles, '--foreground', FALLBACK.foreground),
    mutedForeground: tokenOrFallback(styles, '--muted-foreground', FALLBACK.mutedForeground),
    border: tokenOrFallback(styles, '--border', FALLBACK.border),
  };
}

/** Re-reads the chart theme whenever `<html>`'s `class` attribute changes (light/dark toggle). */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState(readChartTheme);
  useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => setTheme(readChartTheme()));
    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
