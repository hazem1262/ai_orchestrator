import { describe, expect, it } from 'vitest';
import { dropText, shellEscapePath } from './drop-paths.ts';

describe('shellEscapePath', () => {
  it('leaves a plain path alone', () => {
    expect(shellEscapePath('/Users/me/code/my-repo_v2.1')).toBe('/Users/me/code/my-repo_v2.1');
  });

  it('escapes spaces and shell characters', () => {
    expect(shellEscapePath("/Users/me/My Folder (old)/it's&$x")).toBe(
      "/Users/me/My\\ Folder\\ \\(old\\)/it\\'s\\&\\$x",
    );
  });

  it('keeps non-ASCII characters', () => {
    expect(shellEscapePath('/Users/me/résumé')).toBe('/Users/me/résumé');
  });
});

describe('dropText', () => {
  it('joins paths with spaces and ends with a space', () => {
    expect(dropText(['/a b', '/c'])).toBe('/a\\ b /c ');
  });

  it('is empty for no paths', () => {
    expect(dropText([])).toBe('');
  });
});
