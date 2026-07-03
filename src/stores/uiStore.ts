import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface UiState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarVisible: true,
      sidebarWidth: 260,
      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
      setSidebarWidth: (w) => set({ sidebarWidth: Math.max(180, Math.min(560, w)) }),
    }),
    { name: "ariadne-ui", storage: createJSONStorage(() => localStorage) },
  ),
);
