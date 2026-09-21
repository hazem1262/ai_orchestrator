import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface TerminalTab {
  ptyId: string;
  title: string;
}

export interface TerminalState {
  tabs: TerminalTab[];
  active: string | null;
  open(ptyId: string, title: string): void;
  close(ptyId: string): void;
  setActive(ptyId: string): void;
}

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set) => ({
      tabs: [],
      active: null,
      open: (ptyId, title) =>
        set((s) => ({
          tabs: s.tabs.some((t) => t.ptyId === ptyId) ? s.tabs : [...s.tabs, { ptyId, title }],
          active: ptyId,
        })),
      close: (ptyId) =>
        set((s) => {
          const tabs = s.tabs.filter((t) => t.ptyId !== ptyId);
          return { tabs, active: s.active === ptyId ? (tabs.at(-1)?.ptyId ?? null) : s.active };
        }),
      setActive: (ptyId) => set({ active: ptyId }),
    }),
    // PTYs outlive a reload; sessionStorage keeps the tabs for this browser tab only.
    { name: 'orc.terminals', storage: createJSONStorage(() => sessionStorage) },
  ),
);
