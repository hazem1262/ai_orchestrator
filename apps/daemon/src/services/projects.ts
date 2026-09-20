import { type OrcConfig, ProjectConfig } from '@orc/api-contract';
import {
  compileProdPatterns,
  compileTicketRegex,
  DEFAULT_PROD_PATTERNS,
  DEFAULT_TICKET_REGEX,
  type DeriveConfig,
  detectProjects,
  type Project,
} from '@orc/core';
import type { OrcPaths } from '../config.ts';
import type { OrcDb } from '../db/client.ts';
import { replaceProjects } from '../db/repos/projects.ts';
import { listSessionCwds, projectStats, setSessionProject } from '../db/repos/sessions.ts';
import { ServiceError } from './errors.ts';

/** Partial<ProjectConfig> is assignable to this; `features` may also be partial (PATCH semantics). */
export type ProjectUpdate = Omit<Partial<ProjectConfig>, 'features'> & {
  features?: Partial<ProjectConfig['features']>;
};

export interface ProjectService {
  list(): Project[];
  resolve(cwd: string): string | null;
  get(id: string): ProjectConfig | null;
  update(id: string, patch: ProjectUpdate): ProjectConfig;
}

export interface ProjectServiceImpl extends ProjectService {
  ensureDefaults(): void;
  ensureDetected(): { added: string[] };
  deriveConfigFor(cwd: string | null): DeriveConfig;
  syncTable(): void;
}

export interface ProjectServiceDeps {
  db: OrcDb;
  paths: OrcPaths;
  config: () => OrcConfig;
  saveConfig: (cfg: OrcConfig) => void;
}

export const WAKECAP_ID = 'wakecap';

export function projectConfigFor(d: { id: string; name: string; pathPrefix: string }): ProjectConfig {
  const isWakecap = d.id === WAKECAP_ID;
  return ProjectConfig.parse({
    id: d.id,
    name: d.name,
    pathPrefixes: [d.pathPrefix],
    ticketRegex: isWakecap ? DEFAULT_TICKET_REGEX : null,
    prodPatterns: isWakecap ? DEFAULT_PROD_PATTERNS : [],
    features: isWakecap ? { workStreams: true, prodBadges: true, recaps: true } : {},
  });
}

const within = (cwd: string, prefix: string) =>
  cwd === prefix || cwd.startsWith(`${prefix.replace(/\/+$/, '')}/`);

export function createProjectService(deps: ProjectServiceDeps): ProjectServiceImpl {
  const { db } = deps;
  const compiled = new Map<string, DeriveConfig>();
  const fallback: DeriveConfig = {
    ticketRegex: null,
    prodPatterns: compileProdPatterns(DEFAULT_PROD_PATTERNS),
  };

  function save(projects: ProjectConfig[]): void {
    deps.saveConfig({ ...deps.config(), projects });
    compiled.clear();
    svc.syncTable();
  }

  function resolve(cwd: string): string | null {
    if (!cwd) return null;
    let best: { id: string; len: number } | null = null;
    for (const p of deps.config().projects) {
      for (const prefix of p.pathPrefixes) {
        if (within(cwd, prefix) && (!best || prefix.length > best.len))
          best = { id: p.id, len: prefix.length };
      }
    }
    return best?.id ?? null;
  }

  function reassignAll(): void {
    for (const s of listSessionCwds(db)) {
      const id = resolve(s.startCwd);
      if (id !== s.projectId) setSessionProject(db, s.pk, id);
    }
  }

  const svc: ProjectServiceImpl = {
    list() {
      const cfg = deps.config();
      const stats = new Map(projectStats(db).map((s) => [s.projectId, s]));
      return cfg.projects
        .map((p) => ({
          id: p.id,
          name: p.name,
          pathPrefixes: [...p.pathPrefixes],
          hidden: p.hidden,
          lastActivityAt: stats.get(p.id)?.lastActivityAt ?? null,
          sessionCount: stats.get(p.id)?.sessionCount ?? 0,
        }))
        .sort((a, b) => {
          if (a.id === cfg.defaultProjectId) return -1;
          if (b.id === cfg.defaultProjectId) return 1;
          return (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '');
        });
    },
    resolve,
    get(id) {
      return deps.config().projects.find((p) => p.id === id) ?? null;
    },
    update(id, patch) {
      const projects = deps.config().projects;
      const cur = projects.find((p) => p.id === id);
      if (!cur) throw new ServiceError('not_found', 404, `project ${id} not found`);
      const parsed = ProjectConfig.safeParse({
        ...cur,
        ...patch,
        id: cur.id,
        features: { ...cur.features, ...(patch.features ?? {}) },
      });
      if (!parsed.success || parsed.data.pathPrefixes.length === 0) {
        throw new ServiceError(
          'validation_failed',
          400,
          'invalid project update',
          parsed.success ? undefined : parsed.error.issues,
        );
      }
      const next = parsed.data;
      save(projects.map((p) => (p.id === id ? next : p)));
      if (JSON.stringify(next.pathPrefixes) !== JSON.stringify(cur.pathPrefixes)) reassignAll();
      return next;
    },
    ensureDefaults() {
      const projects = deps.config().projects;
      if (projects.some((p) => p.id === WAKECAP_ID)) {
        svc.syncTable();
        return;
      }
      const home = deps.paths.userHome.replace(/\/+$/, '');
      save([
        projectConfigFor({ id: WAKECAP_ID, name: 'Wakecap', pathPrefix: `${home}/Wakecap` }),
        ...projects,
      ]);
    },
    ensureDetected() {
      const home = deps.paths.userHome.replace(/\/+$/, '');
      const samples = listSessionCwds(db).map((s) => ({ cwd: s.startCwd, lastActivityAt: s.lastActivityAt }));
      const projects = [...deps.config().projects];
      const covered = (prefix: string) => projects.some((p) => p.pathPrefixes.some((q) => within(prefix, q)));
      const added: string[] = [];
      for (const d of detectProjects(samples, home)) {
        // Sessions started directly in the home folder stay unassigned ("All projects" shows them);
        // a home-wide project would swallow every future top-level folder.
        if (d.pathPrefix === home || covered(d.pathPrefix) || projects.some((p) => p.id === d.id)) continue;
        projects.push(projectConfigFor(d));
        added.push(d.id);
      }
      if (added.length > 0) save(projects);
      reassignAll();
      return { added };
    },
    deriveConfigFor(cwd) {
      const id = cwd ? resolve(cwd) : null;
      if (!id) return fallback;
      const hit = compiled.get(id);
      if (hit) return hit;
      const p = deps.config().projects.find((x) => x.id === id);
      const cfg: DeriveConfig = p
        ? {
            ticketRegex: compileTicketRegex(p.ticketRegex),
            prodPatterns: compileProdPatterns(p.prodPatterns),
          }
        : fallback;
      compiled.set(id, cfg);
      return cfg;
    },
    syncTable() {
      replaceProjects(
        db,
        deps
          .config()
          .projects.map((p) => ({ id: p.id, name: p.name, pathPrefixes: p.pathPrefixes, hidden: p.hidden })),
      );
    },
  };

  svc.ensureDefaults();
  return svc;
}
