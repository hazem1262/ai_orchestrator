import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export const DEFAULT_PROJECT_ID = 'wakecap';

export interface ProjectState {
  projectId: string;
  /** True once the user picked a project; until then the configured default wins. */
  chosen: boolean;
  setProjectId(projectId: string): void;
  /** Switches to `projectId` without recording it as the user's choice. */
  applyDefault(projectId: string): void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      projectId: DEFAULT_PROJECT_ID,
      chosen: false,
      setProjectId: (projectId) => set({ projectId, chosen: true }),
      applyDefault: (projectId) => set({ projectId }),
    }),
    {
      name: 'orc.project',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Version 0 stored only `projectId`; anything other than the old hard-coded start was a user pick.
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Partial<ProjectState>;
        const projectId = typeof s.projectId === 'string' ? s.projectId : DEFAULT_PROJECT_ID;
        const chosen = version === 0 ? projectId !== DEFAULT_PROJECT_ID : s.chosen === true;
        return { projectId, chosen } as ProjectState;
      },
    },
  ),
);
