import type { ProjectConfig, ProjectPatch } from '@orc/api-contract';

export interface ProjectFormValues {
  name: string;
  prefixes: string;
  hidden: boolean;
  openIn: 'vscode' | 'terminal' | 'finder';
  ticketRegex: string;
}

export function buildProjectPatch(cfg: ProjectConfig, v: ProjectFormValues): ProjectPatch {
  const patch: ProjectPatch = {};
  const name = v.name.trim();
  if (name && name !== cfg.name) patch.name = name;
  const prefixes = v.prefixes
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
  if (prefixes.length > 0 && JSON.stringify(prefixes) !== JSON.stringify(cfg.pathPrefixes)) {
    patch.pathPrefixes = prefixes;
  }
  if (v.hidden !== cfg.hidden) patch.hidden = v.hidden;
  if (v.openIn !== cfg.openIn) patch.openIn = v.openIn;
  const regex = v.ticketRegex.trim() || null;
  if (regex !== cfg.ticketRegex) patch.ticketRegex = regex;
  return patch;
}
