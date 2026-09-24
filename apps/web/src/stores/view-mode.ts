import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ViewMode = 'summary' | 'normal' | 'verbose';

interface ViewModeState {
  mode: ViewMode;
  setMode(mode: ViewMode): void;
}

export const useViewModeStore = create<ViewModeState>()(
  persist((set) => ({ mode: 'normal', setMode: (mode) => set({ mode }) }), {
    name: 'orc.viewMode',
    storage: createJSONStorage(() => localStorage),
  }),
);
