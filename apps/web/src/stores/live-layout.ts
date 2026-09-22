import type { OpenInApp } from '@orc/api-contract';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type LiveLayout = 'grid' | 'list' | 'split';
export type LiveGroupBy = 'none' | 'project' | 'ticket' | 'source';

/** Split view compares at most four sessions; a new pin past that drops the oldest. */
export const MAX_PINNED = 4;

export interface LiveLayoutState {
  layout: LiveLayout;
  pinned: string[];
  groupBy: LiveGroupBy;
  openInByProject: Record<string, OpenInApp>;
  setLayout(layout: LiveLayout): void;
  togglePin(pk: string): void;
  setGroupBy(groupBy: LiveGroupBy): void;
  setOpenIn(projectId: string, app: OpenInApp): void;
}

export const useLiveLayoutStore = create<LiveLayoutState>()(
  persist(
    (set) => ({
      layout: 'grid',
      pinned: [],
      groupBy: 'none',
      openInByProject: {},
      setLayout: (layout) => set({ layout }),
      togglePin: (pk) =>
        set((s) =>
          s.pinned.includes(pk)
            ? { pinned: s.pinned.filter((p) => p !== pk) }
            : { pinned: [...s.pinned, pk].slice(-MAX_PINNED) },
        ),
      setGroupBy: (groupBy) => set({ groupBy }),
      setOpenIn: (projectId, app) =>
        set((s) => ({ openInByProject: { ...s.openInByProject, [projectId]: app } })),
    }),
    { name: 'orc.live-layout', storage: createJSONStorage(() => localStorage) },
  ),
);
