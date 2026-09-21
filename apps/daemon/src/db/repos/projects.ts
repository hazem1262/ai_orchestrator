import { asc } from 'drizzle-orm';
import type { OrcDb } from '../client.ts';
import { projects } from '../schema.ts';

export interface ProjectRow {
  id: string;
  name: string;
  pathPrefixes: string[];
  hidden: boolean;
}

export function replaceProjects(db: OrcDb, list: ProjectRow[]): void {
  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.delete(projects).run();
    for (const p of list) {
      tx.insert(projects)
        .values({
          id: p.id,
          name: p.name,
          pathPrefixesJson: JSON.stringify(p.pathPrefixes),
          hidden: p.hidden,
          updatedAt: now,
        })
        .run();
    }
  });
}

export function listProjectRows(db: OrcDb): ProjectRow[] {
  return db
    .select()
    .from(projects)
    .orderBy(asc(projects.id))
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      pathPrefixes: JSON.parse(r.pathPrefixesJson) as string[],
      hidden: r.hidden,
    }));
}
