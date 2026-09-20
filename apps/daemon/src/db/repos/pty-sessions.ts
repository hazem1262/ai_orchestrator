import { eq } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { ptySessions } from '../schema.ts';

export function insertPtySession(
  db: OrcDb,
  p: {
    id: string;
    sessionPk: string | null;
    command: string;
    args: string[];
    cwd: string;
    pid: number;
    startedAt: string;
  },
): void {
  db.insert(ptySessions)
    .values({
      id: p.id,
      sessionPk: p.sessionPk,
      command: p.command,
      argsJson: JSON.stringify(p.args),
      cwd: p.cwd,
      pid: p.pid,
      startedAt: p.startedAt,
    })
    .run();
}

export function markPtyExited(db: OrcDb, id: string, exitCode: number | null, exitedAt: string): void {
  db.update(ptySessions).set({ exitCode, exitedAt }).where(eq(ptySessions.id, id)).run();
}
