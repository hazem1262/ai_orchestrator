import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY, useThemeStore } from '@/stores/theme.ts';
import { DARK_QUERY, ThemeProvider } from './ThemeProvider.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';

let systemDark = false;
let listeners: Array<(e: MediaQueryListEvent) => void> = [];

function setSystemDark(dark: boolean) {
  systemDark = dark;
  for (const l of listeners) l({ matches: dark } as MediaQueryListEvent);
}

beforeEach(() => {
  systemDark = false;
  listeners = [];
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === DARK_QUERY && systemDark;
    },
    media: query,
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.push(l),
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => {
      listeners = listeners.filter((x) => x !== l);
    },
  }));
  useThemeStore.setState({ theme: 'system' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
});

const isDark = () => document.documentElement.classList.contains('dark');

function renderToggle() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe('theme', () => {
  it('defaults to system and follows the OS preference', () => {
    renderToggle();
    expect(useThemeStore.getState().theme).toBe('system');
    expect(isDark()).toBe(false);
    act(() => setSystemDark(true));
    expect(isDark()).toBe(true);
    act(() => setSystemDark(false));
    expect(isDark()).toBe(false);
  });

  it('cycles system → light → dark → system from the toggle, ignoring the OS when explicit', () => {
    systemDark = true;
    renderToggle();
    expect(isDark()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Theme: System/ }));
    expect(useThemeStore.getState().theme).toBe('light');
    expect(isDark()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Theme: Light/ }));
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(isDark()).toBe(true);
    act(() => setSystemDark(false));
    expect(isDark()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Theme: Dark/ }));
    expect(useThemeStore.getState().theme).toBe('system');
    expect(isDark()).toBe(false);
  });

  it('persists the choice to localStorage', () => {
    renderToggle();
    fireEvent.click(screen.getByRole('button', { name: /Theme: System/ }));
    const stored = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? '{}');
    expect(stored.state.theme).toBe('light');
  });
});
