import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/features/theme/ThemeProvider.tsx';
import { useThemeStore } from '@/stores/theme.ts';
import { CommandDialog, CommandInput, CommandItem, CommandList } from './command.tsx';
import { Dialog, DialogContent, DialogTitle } from './dialog.tsx';
import { Toaster } from './sonner.tsx';
import { useFocusReturn } from './use-focus-return.ts';

describe('CommandDialog', () => {
  beforeAll(() => {
    // cmdk scrolls the selected item into view; jsdom has no layout to scroll.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('renders cmdk parts passed as children when opened', () => {
    render(
      <CommandDialog open onOpenChange={() => undefined}>
        <CommandInput placeholder="Search" />
        <CommandList>
          <CommandItem>Inbox</CommandItem>
        </CommandList>
      </CommandDialog>,
    );
    expect(screen.getByPlaceholderText('Search')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Inbox' })).toBeInTheDocument();
  });
});

describe('Toaster', () => {
  afterEach(() => {
    act(() => toast.dismiss());
    useThemeStore.setState({ theme: 'system' });
  });

  it('takes its theme from the app theme provider', async () => {
    useThemeStore.setState({ theme: 'dark' });
    render(
      <ThemeProvider>
        <Toaster />
      </ThemeProvider>,
    );
    act(() => {
      toast('Saved');
    });
    await screen.findByText('Saved');
    expect(document.querySelector('[data-sonner-toaster]')?.getAttribute('data-sonner-theme')).toBe('dark');
  });
});

describe('useFocusReturn', () => {
  function Opener() {
    const [open, setOpen] = useState(false);
    const onCloseAutoFocus = useFocusReturn(open);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open from state
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent onCloseAutoFocus={onCloseAutoFocus} aria-describedby={undefined}>
            <DialogTitle>Dialog</DialogTitle>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  it('returns focus to the element that opened a dialog without a Radix trigger', async () => {
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'Open from state' });
    await userEvent.click(opener);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});
