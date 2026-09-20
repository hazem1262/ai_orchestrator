import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.ts';

export type OrcDb = BetterSQLite3Database<typeof schema>;

/** src/db/migrations in dev/tests; dist/migrations in the bundle (the build script copies it). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export function openDb(
  file: string,
  opts: { migrationsFolder?: string } = {},
): { db: OrcDb; raw: Database.Database; close(): void } {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const raw = new Database(file);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  if (file !== ':memory:') chmodSync(file, 0o600);
  const db = drizzle({ client: raw, schema });
  migrate(db, { migrationsFolder: opts.migrationsFolder ?? MIGRATIONS_DIR });
  return { db, raw, close: () => raw.close() };
}
