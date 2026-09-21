import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Finds `<claudeHome>/projects/<any>/<sessionId>.jsonl`. The encoded dir name is never decoded
 * (docs/04 A2): the encoding is lossy, so the only reliable way back to a transcript is to look
 * for the file by name. `sessionId` comes from a file on disk we do not own, so it is checked
 * against `SAFE_ID` before ever being joined onto a path — that is what keeps a crafted id from
 * escaping `projects/` via `..` or an absolute segment.
 */
export function createTranscriptFinder(claudeHome: string): (sessionId: string) => string | null {
  const cache = new Map<string, string>();
  return (sessionId) => {
    if (!SAFE_ID.test(sessionId) || sessionId.includes('..')) return null;
    const hit = cache.get(sessionId);
    if (hit && existsSync(hit)) return hit;
    const root = join(claudeHome, 'projects');
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const p = join(root, d, `${sessionId}.jsonl`);
      if (existsSync(p)) {
        cache.set(sessionId, p);
        return p;
      }
    }
    return null;
  };
}
