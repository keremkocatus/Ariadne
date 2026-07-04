import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface UiState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  resultsVisible: boolean;
  paletteOpen: boolean;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  toggleResults: () => void;
  setPaletteOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarVisible: true,
      sidebarWidth: 260,
      resultsVisible: true,
      paletteOpen: false,
      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
      setSidebarWidth: (w) => set({ sidebarWidth: Math.max(180, Math.min(560, w)) }),
      toggleResults: () => set((s) => ({ resultsVisible: !s.resultsVisible })),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
    }),
    {
      name: "ariadne-ui",
      storage: createJSONStorage(() => localStorage),
      // paletteOpen kalıcı değil (her açılışta kapalı başlar).
      partialize: (s) => ({
        sidebarVisible: s.sidebarVisible,
        sidebarWidth: s.sidebarWidth,
        resultsVisible: s.resultsVisible,
      }),
    },
  ),
);
