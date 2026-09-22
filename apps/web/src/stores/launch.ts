import type { LaunchRequestInput } from '@orc/api-contract';
import { create } from 'zustand';

export interface LaunchState {
  open: boolean;
  preset: Partial<LaunchRequestInput> | null;
  show(preset?: Partial<LaunchRequestInput>): void;
  hide(): void;
}

/** Not persisted: a half-filled launch form should never survive a reload. */
export const useLaunchStore = create<LaunchState>()((set) => ({
  open: false,
  preset: null,
  show: (preset) => set({ open: true, preset: preset ?? null }),
  hide: () => set({ open: false, preset: null }),
}));
