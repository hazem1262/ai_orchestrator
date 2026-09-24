import type { OrcConfig } from '@orc/api-contract';
import { checkDenied, DEFAULT_DENY_PATTERNS, type DenyVerdict } from '@orc/core';
import type { ProjectService } from '../projects.ts';

export interface DenyList {
  check(text: string, projectId: string | null): DenyVerdict;
}

export function createDenyList(deps: {
  config: () => OrcConfig;
  projects: Pick<ProjectService, 'get'>;
}): DenyList {
  return {
    check(text, projectId) {
      const project = projectId ? deps.projects.get(projectId) : null;
      return checkDenied(text, [
        ...DEFAULT_DENY_PATTERNS,
        ...deps.config().safety.extraDenyPatterns,
        ...(project?.prodPatterns ?? []),
      ]);
    },
  };
}
