import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'orc.theme';

interface ThemeState {
  theme: Theme;
  setTheme(theme: Theme): void;
}

export const useThemeStore = create<ThemeState>()(
  persist((set) => ({ theme: 'system', setTheme: (theme) => set({ theme }) }), {
    name: THEME_STORAGE_KEY,
    storage: createJSONStorage(() => localStorage),
  }),
);
