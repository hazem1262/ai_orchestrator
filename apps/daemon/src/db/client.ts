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
  // A per-connection (never persisted) view over events_fts's term dictionary, so search can
  // cheaply (~1ms) check how many distinct terms a prefix search would match before paying FTS5
  // snippet()'s cost, which scales with that count (see events.ts's `ftsPrefixCardinality` and
  // task-19-report.md's "Fix round 2"). `IF NOT EXISTS` since some tests share one connection
  // across repeated `openDb`-like setup paths.
  raw.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.events_vocab USING fts5vocab(main, events_fts, row)');
  return { db, raw, close: () => raw.close() };
}
