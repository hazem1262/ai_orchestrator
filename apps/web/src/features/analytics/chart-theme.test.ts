import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readChartTheme, useChartTheme } from './chart-theme.ts';

function setStyle(css: string): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

describe('readChartTheme', () => {
  let style: HTMLStyleElement;

  afterEach(() => {
    style.remove();
    document.documentElement.classList.remove('dark');
  });

  it('reads the chart tokens off <html> for the active theme', () => {
    style = setStyle(`
      :root { --chart-1: rgb(1, 2, 3); --foreground: rgb(4, 5, 6); --muted-foreground: rgb(7, 8, 9); --border: rgb(10, 11, 12); }
      .dark { --chart-1: rgb(21, 22, 23); }
    `);
    const theme = readChartTheme();
    // jsdom's computed style serializes rgb() without the spaces the stylesheet was written with.
    expect(theme.colors[0]).toBe('rgb(1,2,3)');
    expect(theme.foreground).toBe('rgb(4,5,6)');
    expect(theme.mutedForeground).toBe('rgb(7,8,9)');
    expect(theme.border).toBe('rgb(10,11,12)');

    document.documentElement.classList.add('dark');
    expect(readChartTheme().colors[0]).toBe('rgb(21,22,23)');
  });
});

describe('useChartTheme', () => {
  let style: HTMLStyleElement;

  beforeEach(() => {
    style = setStyle(`
      :root { --chart-1: rgb(1, 2, 3); }
      .dark { --chart-1: rgb(21, 22, 23); }
    `);
  });

  afterEach(() => {
    style.remove();
    document.documentElement.classList.remove('dark');
  });

  it('re-reads the tokens when the app toggles the dark class on <html>', async () => {
    const { result } = renderHook(() => useChartTheme());
    expect(result.current.colors[0]).toBe('rgb(1,2,3)');

    await act(async () => {
      document.documentElement.classList.add('dark');
      await Promise.resolve();
    });
    expect(result.current.colors[0]).toBe('rgb(21,22,23)');

    await act(async () => {
      document.documentElement.classList.remove('dark');
      await Promise.resolve();
    });
    expect(result.current.colors[0]).toBe('rgb(1,2,3)');
  });
});
