import { describe, expect, it, vi } from 'vitest';
import { createHotkeyRegistry, formatKeys, type KeyLike } from './registry.ts';

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  target: null,
  preventDefault: vi.fn(),
  ...extra,
});

function setup() {
  let t = 0;
  const reg = createHotkeyRegistry(() => t);
  const advance = (ms: number) => {
    t += ms;
  };
  return { reg, advance };
}

describe('hotkey registry', () => {
  it('handles two-key sequences within the timeout', () => {
    const { reg, advance } = setup();
    const inbox = vi.fn();
    reg.register({ id: 'go-inbox', keys: 'g i', description: 'Inbox', group: 'navigation', handler: inbox });
    const g = key('g');
    expect(reg.handle(g)).toBe(true);
    expect(g.preventDefault).toHaveBeenCalled();
    advance(500);
    expect(reg.handle(key('i'))).toBe(true);
    expect(inbox).toHaveBeenCalledTimes(1);
    reg.handle(key('g'));
    advance(1500);
    expect(reg.handle(key('i'))).toBe(false);
    expect(inbox).toHaveBeenCalledTimes(1);
  });

  it('matches mod+k with meta or ctrl, even inside inputs when allowed', () => {
    const { reg } = setup();
    const palette = vi.fn();
    const n = vi.fn();
    reg.register({
      id: 'palette',
      keys: 'mod+k',
      description: 'Palette',
      group: 'actions',
      handler: palette,
      allowInInputs: true,
    });
    reg.register({ id: 'new', keys: 'n', description: 'New', group: 'actions', handler: n });
    const input = document.createElement('input');
    expect(reg.handle(key('k', { metaKey: true, target: input }))).toBe(true);
    expect(reg.handle(key('K', { ctrlKey: true }))).toBe(true);
    expect(palette).toHaveBeenCalledTimes(2);
    expect(reg.handle(key('n', { target: input }))).toBe(false);
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.appendChild(editor);
    expect(reg.handle(key('n', { target: editor }))).toBe(false);
    expect(reg.handle(key('n'))).toBe(true);
    expect(n).toHaveBeenCalledTimes(1);
  });

  it('lets later bindings override and restores on unregister', () => {
    const { reg } = setup();
    const a = vi.fn();
    const b = vi.fn();
    reg.register({ id: 'a', keys: 'j', description: 'A', group: 'session', handler: a });
    const off = reg.register({ id: 'b', keys: 'j', description: 'B', group: 'inbox', handler: b });
    reg.handle(key('j'));
    expect(b).toHaveBeenCalledTimes(1);
    expect(reg.list().map((x) => x.id)).toEqual(['b']);
    off();
    reg.handle(key('j'));
    expect(a).toHaveBeenCalledTimes(1);
    expect(reg.list().map((x) => x.id)).toEqual(['a']);
  });

  it('ignores bare modifier presses and unknown keys', () => {
    const { reg } = setup();
    expect(reg.handle(key('Shift'))).toBe(false);
    expect(reg.handle(key('x'))).toBe(false);
  });

  it('formats keys for display', () => {
    expect(formatKeys('mod+k', true)).toBe('⌘K');
    expect(formatKeys('mod+k', false)).toBe('Ctrl+K');
    expect(formatKeys('g i', true)).toBe('G then I');
    expect(formatKeys('n', true)).toBe('N');
  });
});
