import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input.tsx';

export interface CodeBoxesProps {
  /** Base id; each box is `${id}-${index}` so a caller can label the group without a ref. */
  id: string;
  length: number;
  value: string;
  onChange: (value: string) => void;
  groupLabel: string;
  disabled?: boolean;
  invalid?: boolean;
}

function boxId(id: string, index: number): string {
  return `${id}-${index}`;
}

function clean(text: string, length: number): string {
  return text
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, length);
}

function focusBox(id: string, index: number): void {
  document.getElementById(boxId(id, index))?.focus();
}

/**
 * A pairing code entered as one box per character. Pasting anywhere fills every box from the
 * start; typing a character advances to the next box; backspace on an empty box steps back and
 * clears the box behind it, matching a one-time-code keypad.
 */
export function CodeBoxes({ id, length, value, onChange, groupLabel, disabled, invalid }: CodeBoxesProps) {
  const chars = Array.from({ length }, (_, i) => value[i] ?? '');

  function handleChange(index: number, e: ChangeEvent<HTMLInputElement>) {
    const cleanedFull = clean(e.target.value, length);
    if (cleanedFull.length > 1) {
      onChange(cleanedFull);
      focusBox(id, Math.min(cleanedFull.length, length - 1));
      return;
    }
    const next = [...chars];
    next[index] = cleanedFull;
    onChange(next.join(''));
    if (cleanedFull && index < length - 1) focusBox(id, index + 1);
  }

  function handleKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Backspace' || chars[index] !== '' || index === 0) return;
    e.preventDefault();
    const next = [...chars];
    next[index - 1] = '';
    onChange(next.join(''));
    focusBox(id, index - 1);
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const cleaned = clean(e.clipboardData.getData('text'), length);
    if (!cleaned) return;
    e.preventDefault();
    onChange(cleaned);
    focusBox(id, Math.min(cleaned.length, length - 1));
  }

  return (
    <fieldset aria-label={groupLabel} className="flex gap-1.5 border-0 p-0">
      {chars.map((char, index) => (
        <Input
          key={boxId(id, index)}
          id={boxId(id, index)}
          value={char}
          onChange={(e) => handleChange(index, e)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onPaste={handlePaste}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-label={`${groupLabel}, character ${index + 1} of ${length}`}
          autoCapitalize="characters"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          inputMode="text"
          className="h-11 w-9 text-center text-lg uppercase tracking-widest sm:w-10"
        />
      ))}
    </fieldset>
  );
}
