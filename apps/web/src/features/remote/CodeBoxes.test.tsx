import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { CodeBoxes } from './CodeBoxes.tsx';

function Harness({ length = 8 }: { length?: number }) {
  const [value, setValue] = useState('');
  return <CodeBoxes id="code" length={length} value={value} onChange={setValue} groupLabel="Pairing code" />;
}

function boxes(): HTMLInputElement[] {
  return within(screen.getByRole('group', { name: 'Pairing code' })).getAllByRole(
    'textbox',
  ) as HTMLInputElement[];
}

describe('CodeBoxes', () => {
  it('renders one box per character', () => {
    render(<Harness />);
    expect(boxes()).toHaveLength(8);
  });

  it('advances to the next box as each character is typed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const [b0, b1, b2] = boxes();
    if (!b0 || !b1 || !b2) throw new Error('expected 3 boxes');
    await user.type(b0, 'A');
    expect(b1).toHaveFocus();
    await user.type(b1, 'B');
    expect(b2).toHaveFocus();
    expect(b0.value).toBe('A');
    expect(b1.value).toBe('B');
  });

  it('fills every box when the whole code is pasted', () => {
    render(<Harness />);
    const all = boxes();
    const first = all[0];
    if (!first) throw new Error('expected a first box');
    fireEvent.paste(first, { clipboardData: { getData: () => 'abcd2345' } });
    expect(all.map((box) => box.value)).toEqual(['A', 'B', 'C', 'D', '2', '3', '4', '5']);
    expect(all[7]).toHaveFocus();
  });

  it('pasting a short code fills from the start and leaves the rest empty', () => {
    render(<Harness />);
    const all = boxes();
    const fourth = all[3];
    if (!fourth) throw new Error('expected a fourth box');
    fireEvent.paste(fourth, { clipboardData: { getData: () => 'abc' } });
    expect(all.map((box) => box.value)).toEqual(['A', 'B', 'C', '', '', '', '', '']);
    expect(all[3]).toHaveFocus();
  });

  it('backspace on an empty box steps back and clears the box behind it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const [b0, b1] = boxes();
    if (!b0 || !b1) throw new Error('expected 2 boxes');
    await user.type(b0, 'A');
    await user.type(b1, 'B');
    // focus is now on box 2 (empty); backspace should step back to box 1 and clear it
    await user.keyboard('{Backspace}');
    expect(b1).toHaveFocus();
    expect(b1.value).toBe('');
    expect(b0.value).toBe('A');
  });

  it('backspace on a filled box clears it in place without moving focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const [b0] = boxes();
    if (!b0) throw new Error('expected a first box');
    await user.type(b0, 'A');
    b0.focus();
    await user.keyboard('{Backspace}');
    expect(b0.value).toBe('');
    expect(b0).toHaveFocus();
  });
});
