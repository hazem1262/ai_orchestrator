import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { watch } from 'chokidar';

const dir = join(homedir(), '.claude', 'sessions');
const last = new Map<string, string>();

watch(dir, { ignored: (p) => p.endsWith('.key'), ignoreInitial: false, awaitWriteFinish: false }).on(
  'all',
  (ev, path) => {
    if (!path.endsWith('.json')) return;
    try {
      const j = JSON.parse(readFileSync(path, 'utf8')) as {
        pid: number;
        status: string;
        statusUpdatedAt: number;
        waitingFor?: string;
      };
      const prev = last.get(path);
      if (prev !== j.status) {
        const lagMs = Date.now() - j.statusUpdatedAt;
        console.log(
          new Date().toISOString(),
          ev,
          j.pid,
          `${prev ?? '-'} → ${j.status}`,
          j.waitingFor ?? '',
          `lag=${lagMs}ms`,
        );
        last.set(path, j.status);
      }
    } catch (e) {
      console.log('parse error (partial write?)', path, String(e));
    }
  },
);
console.log('watching', dir);
