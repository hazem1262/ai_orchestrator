import { create } from 'zustand';

export type StreamView = 'list' | 'kanban';
const KEY = 'orc.stream-view';

function load(): StreamView {
  try {
    return window.localStorage.getItem(KEY) === 'kanban' ? 'kanban' : 'list';
  } catch {
    return 'list';
  }
}

export const useStreamViewStore = create<{ view: StreamView; setView(v: StreamView): void }>((set) => ({
  view: load(),
  setView(view) {
    try {
      window.localStorage.setItem(KEY, view);
    } catch {
      // private window or blocked storage: keep it in memory only
    }
    set({ view });
  },
}));
