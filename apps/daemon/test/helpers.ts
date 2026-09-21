import { OrcConfig } from '@orc/api-contract';
import type Database from 'better-sqlite3';
import { pino } from 'pino';
import { afterEach, beforeEach } from 'vitest';
import { saveConfig } from '../src/config.ts';
import { buildContext, type DaemonContext } from '../src/context.ts';
import { createIndexer, type Indexer } from '../src/indexer/indexer.ts';
import type { ExternalLauncher } from '../src/services/external.ts';
import { FAKE_CLAUDE, makeTempHomes, type TempHomes } from './homes.ts';

export * from './homes.ts';

/** Fresh temp copies of the fixture homes for every test in the calling `describe`. */
export function useTempHomes(): TempHomes {
  const holder = {} as TempHomes;
  beforeEach(() => {
    Object.assign(holder, makeTempHomes());
  });
  afterEach(() => {
    holder.cleanup();
  });
  return holder;
}

export interface TestContext extends DaemonContext {
  homes: TempHomes;
  raw: Database.Database;
  launches: Array<Parameters<ExternalLauncher>[0]>;
  dispose(): void;
}

/**
 * Real services on temp homes: fake `claude` for resumes, a recording external launcher
 * (never runs osascript), silent logs and "every pid is dead" unless `isPidAlive` is given.
 */
export function createTestContext(
  opts: Partial<DaemonContext> & { homes?: TempHomes; isPidAlive?: (pid: number) => boolean } = {},
): TestContext {
  const { homes: given, isPidAlive, ...overrides } = opts;
  const homes = given ?? makeTempHomes();
  saveConfig(
    homes.paths,
    OrcConfig.parse({ resumeProfile: { claudeCommand: FAKE_CLAUDE, codexCommand: FAKE_CLAUDE } }),
  );
  const launches: TestContext['launches'] = [];
  const built = buildContext({
    paths: homes.paths,
    log: pino({ level: 'silent' }),
    launchExternal: async (i) => {
      launches.push(i);
    },
    isPidAlive: isPidAlive ?? (() => false),
  });
  return {
    ...built.ctx,
    ...overrides,
    homes,
    raw: built.raw,
    launches,
    dispose: () => {
      built.close();
      if (!given) homes.cleanup();
    },
  };
}

export async function indexFixtures(ctx: TestContext): Promise<Indexer> {
  const indexer = createIndexer({
    db: ctx.db,
    raw: ctx.raw,
    paths: ctx.paths,
    projects: ctx.projects,
    bus: ctx.bus,
    log: ctx.log,
  });
  await indexer.scanAll();
  return indexer;
}
