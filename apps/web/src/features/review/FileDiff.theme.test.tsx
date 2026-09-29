import type { DiffFileEntry } from '@orc/core';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/features/theme/ThemeProvider.tsx';
import { useThemeStore } from '@/stores/theme.ts';
import { FileDiff } from './FileDiff.tsx';

const diffViewProps = vi.hoisted(() => [] as Array<{ diffViewTheme?: string }>);
vi.mock('@git-diff-view/react', () => ({
  DiffModeEnum: { Split: 1, Unified: 2 },
  SplitSide: { old: 1, new: 2 },
  DiffView: (props: { diffViewTheme?: string }) => {
    diffViewProps.push(props);
    return null;
  },
}));

const file = {
  path: 'src/a.ts',
  status: 'modified',
  hunks: [],
  patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
} as unknown as DiffFileEntry;

afterEach(() => useThemeStore.setState({ theme: 'system' }));

describe('FileDiff theme', () => {
  it('passes the resolved app theme to the diff view and follows a toggle', () => {
    act(() => useThemeStore.setState({ theme: 'light' }));
    render(
      <ThemeProvider>
        <FileDiff
          file={file}
          mode="unified"
          comments={[]}
          canRevert={false}
          onAddComment={() => {}}
          onRevertFile={() => {}}
          onRevertHunk={() => {}}
        />
      </ThemeProvider>,
    );
    expect(diffViewProps.at(-1)?.diffViewTheme).toBe('light');
    act(() => useThemeStore.setState({ theme: 'dark' }));
    expect(diffViewProps.at(-1)?.diffViewTheme).toBe('dark');
    act(() => useThemeStore.setState({ theme: 'light' }));
    expect(diffViewProps.at(-1)?.diffViewTheme).toBe('light');
  });
});
