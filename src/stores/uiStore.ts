import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/// Kullanıcı ayarları (design 15 §P1-U4). v1 bilinçli minimal; liste büyürse
/// P1-M2 SQLite deposuna taşınabilir. localStorage'da persist edilir.
export interface Settings {
  /** Editör font boyutu (px). */
  editorFontSize: number;
  /** Zaten-bağlı bağlantıya geçerken şemanın "bayat" sayıldığı eşik (dakika). */
  schemaStaleMinutes: number;
  /** Arka plandaki tab'ın sorgusu bu süreyi (sn) aşınca bitiş toast'ı (design 17
   *  §P1-V1 Ö7). 0 = kapalı. */
  longQueryNoticeSeconds: number;
}
export const DEFAULT_SETTINGS: Settings = {
  editorFontSize: 13,
  schemaStaleMinutes: 5,
  longQueryNoticeSeconds: 10,
};

/// Sol panel sekmesi (design 15 §P1-U4 + design 17 §P1-V4). uiStore'da tutulur ki
/// palette "Show activity" gibi eylemler programatik sekme değiştirebilsin.
export type SidebarTab = "explorer" | "roles" | "activity";

interface UiState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  sidebarTab: SidebarTab;
  resultsVisible: boolean;
  paletteOpen: boolean;
  settingsOpen: boolean;
  /// Bağlantı menüsü kontrollü açık mı (design 17 §P1-V1): boş-durum kartındaki
  /// "Connect…" butonu bunu programatik açar; ConnectionMenu bu state'e bağlanır.
  connectMenuOpen: boolean;
  settings: Settings;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleResults: () => void;
  setResultsVisible: (v: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setConnectMenuOpen: (open: boolean) => void;
  updateSettings: (patch: Partial<Settings>) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarVisible: true,
      sidebarWidth: 260,
      sidebarTab: "explorer",
      resultsVisible: true,
      paletteOpen: false,
      settingsOpen: false,
      connectMenuOpen: false,
      settings: DEFAULT_SETTINGS,
      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
      setSidebarWidth: (w) => set({ sidebarWidth: Math.max(180, Math.min(560, w)) }),
      setSidebarTab: (tab) => set({ sidebarTab: tab }),
      toggleResults: () => set((s) => ({ resultsVisible: !s.resultsVisible })),
      setResultsVisible: (v) => set({ resultsVisible: v }),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setConnectMenuOpen: (open) => set({ connectMenuOpen: open }),
      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
    }),
    {
      name: "ariadne-ui",
      storage: createJSONStorage(() => localStorage),
      // paletteOpen/settingsOpen kalıcı değil (her açılışta kapalı başlar).
      partialize: (s) => ({
        sidebarVisible: s.sidebarVisible,
        sidebarWidth: s.sidebarWidth,
        sidebarTab: s.sidebarTab,
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
