import { type ComponentProps, useEffect, useState } from 'react';
import { Input } from '@/components/ui/input.tsx';

type NumberInputProps = Omit<ComponentProps<'input'>, 'type' | 'value' | 'onChange'> & {
  value: number | null;
  /** Called with the parsed number, or `null` when the field is emptied. */
  onValue(n: number | null): void;
};

/**
 * A number field that keeps its own text, so a user can clear it and type a new value
 * without the parent's last valid number being re-inserted in between.
 */
export function NumberInput({ value, onValue, ...rest }: NumberInputProps) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    setText((t) => (t.trim() !== '' && Number(t) === value ? t : value === null ? '' : String(value)));
  }, [value]);

  return (
    <Input
      {...rest}
      type="number"
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        if (v.trim() === '') onValue(null);
        else if (Number.isFinite(Number(v))) onValue(Number(v));
      }}
    />
  );
}
