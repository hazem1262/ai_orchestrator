import { OrcConfig } from '@orc/api-contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession } from '../../test/factories.ts';
import { useTempHomes } from '../../test/helpers.ts';
import { loadConfig, saveConfig } from '../config.ts';
import { type OrcDb, openDb } from '../db/client.ts';
import { listProjectRows } from '../db/repos/projects.ts';
import { getSessionByPk, upsertSession } from '../db/repos/sessions.ts';
import { createProjectService, type ProjectServiceImpl } from './projects.ts';

const errorOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
};

describe('project service', () => {
  const homes = useTempHomes();
  let db: OrcDb;
  let cfg: OrcConfig;
  let svc: ProjectServiceImpl;

  beforeEach(() => {
    db = openDb(homes.paths.dbFile).db;
    cfg = loadConfig(homes.paths);
    svc = createProjectService({
      db,
      paths: homes.paths,
      config: () => cfg,
      saveConfig: (next) => {
        saveConfig(homes.paths, next);
        cfg = next;
      },
    });
  });

  it('creates the wakecap default project with its features', () => {
    expect(cfg.projects).toHaveLength(1);
    expect(svc.get('wakecap')).toMatchObject({
      id: 'wakecap',
      name: 'Wakecap',
      pathPrefixes: ['/Users/test/Wakecap'],
      ticketRegex: '\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b',
      features: { workStreams: true, prodBadges: true, recaps: true },
    });
    expect(svc.get('wakecap')?.prodPatterns).toContain('production_server_db');
    expect(loadConfig(homes.paths).projects.map((p) => p.id)).toEqual(['wakecap']);
    expect(listProjectRows(db).map((p) => p.id)).toEqual(['wakecap']);
  });

  it('resolves by longest prefix on path boundaries', () => {
    svc.update('wakecap', { pathPrefixes: ['/Users/test/Wakecap', '/Users/test/Wakecap/Backend'] });
    cfg = OrcConfig.parse({
      ...cfg,
      projects: [
        ...cfg.projects,
        { id: 'backend', name: 'Backend', pathPrefixes: ['/Users/test/Wakecap/Backend/svc'] },
      ],
    });
    expect(svc.resolve('/Users/test/Wakecap/Backend/svc/src')).toBe('backend');
    expect(svc.resolve('/Users/test/Wakecap')).toBe('wakecap');
    expect(svc.resolve('/Users/test/WakecapOld')).toBeNull();
    expect(svc.resolve('')).toBeNull();
  });

  it('detects projects from session cwds and reassigns sessions', () => {
    upsertSession(
      db,
      makeSession({
        id: 'w',
        projectId: null,
        startCwd: '/Users/test/Wakecap/Backend/svc',
        lastActivityAt: '2026-09-06T00:00:00.000Z',
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: 'f',
        projectId: null,
        startCwd: '/Users/test/Forza',
        lastActivityAt: '2026-09-04T00:00:00.000Z',
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: 's',
        projectId: null,
        startCwd: '/Users/test/Stocks/EGX',
        lastActivityAt: '2026-09-02T00:00:00.000Z',
      }),
    );
    const { added } = svc.ensureDetected();
    expect(added).toEqual(['forza', 'stocks']);
    expect(getSessionByPk(db, 'claude:w')?.projectId).toBe('wakecap');
    expect(getSessionByPk(db, 'claude:f')?.projectId).toBe('forza');
    expect(svc.get('forza')).toMatchObject({
      ticketRegex: null,
      prodPatterns: [],
      features: { workStreams: false },
    });
    expect(svc.list().map((p) => [p.id, p.sessionCount])).toEqual([
      ['wakecap', 1],
      ['forza', 1],
      ['stocks', 1],
    ]);
    expect(svc.ensureDetected().added).toEqual([]);
  });

  it('a second detection pass never clobbers a renamed, hidden or merged project', () => {
    upsertSession(
      db,
      makeSession({
        id: 'w',
        projectId: null,
        startCwd: '/Users/test/Wakecap',
        lastActivityAt: '2026-09-06T00:00:00.000Z',
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: 'f',
        projectId: null,
        startCwd: '/Users/test/Forza',
        lastActivityAt: '2026-09-04T00:00:00.000Z',
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: 's',
        projectId: null,
        startCwd: '/Users/test/Stocks/EGX',
        lastActivityAt: '2026-09-02T00:00:00.000Z',
      }),
    );
    expect(svc.ensureDetected().added).toEqual(['forza', 'stocks']);

    // User renames forza, hides stocks, and merges stocks' path into forza's prefixes.
    svc.update('forza', { name: 'Forza Racing' });
    svc.update('stocks', { hidden: true });
    svc.update('forza', { pathPrefixes: ['/Users/test/Forza', '/Users/test/Stocks'] });

    // A new session appears under a brand-new top-level folder; re-running detection must
    // pick that up without touching the projects the user already edited.
    upsertSession(
      db,
      makeSession({
        id: 'n',
        projectId: null,
        startCwd: '/Users/test/NewCo',
        lastActivityAt: '2026-09-08T00:00:00.000Z',
      }),
    );
    const { added } = svc.ensureDetected();

    expect(added).toEqual(['newco']);
    expect(svc.get('forza')).toMatchObject({
      name: 'Forza Racing',
      pathPrefixes: ['/Users/test/Forza', '/Users/test/Stocks'],
    });
    expect(svc.get('stocks')).toMatchObject({ hidden: true });
    // Sessions under the merged-in path now resolve to forza (longest matching prefix), and
    // nothing was deleted: stocks still exists as a hidden project.
    expect(getSessionByPk(db, 'claude:s')?.projectId).toBe('forza');
    expect(
      loadConfig(homes.paths)
        .projects.map((p) => p.id)
        .sort(),
    ).toEqual(['forza', 'newco', 'stocks', 'wakecap'].sort());
  });

  it('builds derive config per project', () => {
    const w = svc.deriveConfigFor('/Users/test/Wakecap/x');
    expect(w.ticketRegex?.source).toBe('\\b(SAF|ALU|SUPRT|SAK|TAN)-\\d+\\b');
    const other = svc.deriveConfigFor('/Users/test/Elsewhere');
    expect(other.ticketRegex).toBeNull();
    expect(other.prodPatterns.length).toBeGreaterThan(0);
    expect(svc.deriveConfigFor(null).ticketRegex).toBeNull();
  });

  it('updates, validates and hides without deleting', () => {
    const next = svc.update('wakecap', {
      name: 'WakeCap',
      hidden: true,
      openIn: 'terminal',
      features: { recaps: false },
    });
    expect(next).toMatchObject({
      name: 'WakeCap',
      hidden: true,
      openIn: 'terminal',
      features: { workStreams: true, recaps: false },
    });
    expect(svc.list()[0]).toMatchObject({ id: 'wakecap', hidden: true });
    expect(errorOf(() => svc.update('nope', { name: 'x' }))).toMatchObject({
      code: 'not_found',
      status: 404,
    });
    expect(errorOf(() => svc.update('wakecap', { pathPrefixes: [] }))).toMatchObject({
      code: 'validation_failed',
      status: 400,
    });
  });
});
