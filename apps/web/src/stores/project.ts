import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export const DEFAULT_PROJECT_ID = 'wakecap';

export interface ProjectState {
  projectId: string;
  setProjectId(projectId: string): void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      projectId: DEFAULT_PROJECT_ID,
      setProjectId: (projectId) => set({ projectId }),
    }),
    { name: 'orc.project', storage: createJSONStorage(() => localStorage) },
  ),
);
