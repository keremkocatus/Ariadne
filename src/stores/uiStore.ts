import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/// Kullanıcı ayarları (design 15 §P1-U4). v1 bilinçli minimal; liste büyürse
/// P1-M2 SQLite deposuna taşınabilir. localStorage'da persist edilir.
export interface Settings {
  /** Editör font boyutu (px). */
  editorFontSize: number;
  /** Zaten-bağlı bağlantıya geçerken şemanın "bayat" sayıldığı eşik (dakika). */
  schemaStaleMinutes: number;
}
export const DEFAULT_SETTINGS: Settings = {
  editorFontSize: 13,
  schemaStaleMinutes: 5,
};

interface UiState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  resultsVisible: boolean;
  paletteOpen: boolean;
  settingsOpen: boolean;
  settings: Settings;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  toggleResults: () => void;
  setResultsVisible: (v: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  updateSettings: (patch: Partial<Settings>) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarVisible: true,
      sidebarWidth: 260,
      resultsVisible: true,
      paletteOpen: false,
      settingsOpen: false,
      settings: DEFAULT_SETTINGS,
      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
      setSidebarWidth: (w) => set({ sidebarWidth: Math.max(180, Math.min(560, w)) }),
      toggleResults: () => set((s) => ({ resultsVisible: !s.resultsVisible })),
      setResultsVisible: (v) => set({ resultsVisible: v }),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
    }),
    {
      name: "ariadne-ui",
      storage: createJSONStorage(() => localStorage),
      // paletteOpen/settingsOpen kalıcı değil (her açılışta kapalı başlar).
      partialize: (s) => ({
        sidebarVisible: s.sidebarVisible,
        sidebarWidth: s.sidebarWidth,
        resultsVisible: s.resultsVisible,
        settings: s.settings,
      }),
      // Eski persist'te settings yoksa varsayılanla birleştir.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UiState>;
        return { ...current, ...p, settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) } };
      },
    },
  ),
);
