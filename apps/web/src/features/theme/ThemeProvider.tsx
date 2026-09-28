import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { type Theme, useThemeStore } from '@/stores/theme.ts';

export const DARK_QUERY = '(prefers-color-scheme: dark)';

/** `matchMedia` is missing in jsdom and some embedded views; without it "system" means light. */
function darkQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(DARK_QUERY);
}

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => darkQuery()?.matches ?? false);
  useEffect(() => {
    const mql = darkQuery();
    if (!mql) return;
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    setDark(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return dark;
}

export function resolveTheme(theme: Theme, systemDark: boolean): 'light' | 'dark' {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}

const ResolvedThemeContext = createContext<'light' | 'dark'>('light');

/** The theme actually on screen ("system" already resolved); light outside a `ThemeProvider`. */
export function useResolvedTheme(): 'light' | 'dark' {
  return useContext(ResolvedThemeContext);
}

/** Keeps the `dark` class on `<html>` in step with the chosen theme (and the OS, for "system"). */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useThemeStore((s) => s.theme);
  const systemDark = useSystemDark();
  const resolved = resolveTheme(theme, systemDark);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);
  return <ResolvedThemeContext value={resolved}>{children}</ResolvedThemeContext>;
}
