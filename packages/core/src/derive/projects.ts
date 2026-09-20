export interface ProjectSample {
  cwd: string;
  lastActivityAt: string;
}

export interface DetectedProject {
  id: string;
  name: string;
  pathPrefix: string;
  lastActivityAt: string;
  sessionCount: number;
}

export function projectRootFor(cwd: string, userHome: string): string {
  const home = userHome.replace(/\/+$/, '');
  if (cwd === home) return home;
  if (cwd.startsWith(`${home}/`)) {
    const first = cwd.slice(home.length + 1).split('/')[0] ?? '';
    return `${home}/${first}`;
  }
  const first = cwd.split('/').filter(Boolean)[0];
  return first ? `/${first}` : '/';
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'project';
}

/** F13: one project per top-level folder under the user's home, most recently active first. */
export function detectProjects(samples: ProjectSample[], userHome: string): DetectedProject[] {
  const home = userHome.replace(/\/+$/, '');
  const byRoot = new Map<string, DetectedProject>();
  for (const s of samples) {
    if (!s.cwd) continue;
    const root = projectRootFor(s.cwd, home);
    const cur = byRoot.get(root);
    if (cur) {
      cur.sessionCount += 1;
      if (s.lastActivityAt > cur.lastActivityAt) cur.lastActivityAt = s.lastActivityAt;
      continue;
    }
    const name = root === home ? 'Home' : (root.split('/').filter(Boolean).at(-1) ?? 'root');
    byRoot.set(root, { id: '', name, pathPrefix: root, lastActivityAt: s.lastActivityAt, sessionCount: 1 });
  }
  const list = [...byRoot.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const used = new Set<string>();
  for (const p of list) {
    const base = slugify(p.name);
    let id = base;
    let n = 2;
    while (used.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    used.add(id);
    p.id = id;
  }
  return list;
}
