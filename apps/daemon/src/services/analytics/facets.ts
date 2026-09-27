import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 1024 * 1024;

/** Reads ~/.claude/usage-data/facets/*.json (read-only). Unparseable files are skipped. */
export function readFacets(claudeHome: string): unknown[] {
  const dir = join(claudeHome, 'usage-data', 'facets');
  if (!existsSync(dir)) return [];
  const out: unknown[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isFile() || !d.name.endsWith('.json')) continue;
    const file = join(dir, d.name);
    try {
      if (statSync(file).size > MAX_BYTES) continue;
      out.push(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      // skip
    }
  }
  return out;
}
