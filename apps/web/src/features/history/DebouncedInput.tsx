import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input.tsx';

export function DebouncedInput({
  value,
  onCommit,
  delayMs = 250,
  ...rest
}: { value: string; onCommit(v: string): void; delayMs?: number } & Omit<
  ComponentProps<'input'>,
  'value' | 'onChange'
>) {
  const [text, setText] = useState(value);
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  }, [onCommit]);
  // external changes (saved view, clear filters) win unless they only differ by surrounding whitespace
  useEffect(() => {
    setText((cur) => (cur.trim() === value ? cur : value));
  }, [value]);
  useEffect(() => {
    if (text.trim() === value) return;
    const t = setTimeout(() => commit.current(text.trim()), delayMs);
    return () => clearTimeout(t);
  }, [text, value, delayMs]);
  return <Input value={text} onChange={(e) => setText(e.target.value)} {...rest} />;
}
