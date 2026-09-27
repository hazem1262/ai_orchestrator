import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
// Phase 7 code that runs without a human in the loop. It must never be able to merge or ship.
const GUARDED_DIRS = [
  'services/automations',
  'services/supervisor',
  'connectors/linear/assigned-poller.ts',
  'connectors/slack/mention-poller.ts',
];

function files(p: string): string[] {
  const abs = join(SRC, p);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs).flatMap((n) => files(join(p, n)));
}

describe('automation and supervisor code cannot merge', () => {
  const all = GUARDED_DIRS.flatMap(files).filter((f) => f.endsWith('.ts'));

  it('finds the guarded files', () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it.each(all.map((f) => [f.slice(SRC.length), f]))('%s has no merge or ship calls', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/\.merge\s*\(/);
    expect(text).not.toMatch(/ctx\.ship\b/);
    expect(text).not.toMatch(/from ['"][./]*(services\/)?ship\//);
    expect(text).not.toMatch(/\bplans?\.approve\s*\(/);
  });
});
