import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/// User settings. Deliberately minimal for now; could move to a local store later.
/// Persisted in localStorage.
export interface Settings {
  /** Editor font size (px). */
  editorFontSize: number;
  /** Threshold (minutes) after which a schema is considered "stale" when switching to
   *  an already-connected connection. */
  schemaStaleMinutes: number;
  /** If a background tab's query exceeds this many seconds, show a finish toast.
   *  0 = off. */
  longQueryNoticeSeconds: number;
}
export const DEFAULT_SETTINGS: Settings = {
  editorFontSize: 13,
  schemaStaleMinutes: 5,
  longQueryNoticeSeconds: 10,
};

/// The left panel's active tab. Kept in uiStore so the palette can switch it
/// programmatically.
export type SidebarTab = "explorer" | "roles" | "history";

interface UiState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  sidebarTab: SidebarTab;
  resultsVisible: boolean;
  /// The results panel height (px). The editor fills the remaining space above it
  /// (flex-1); the results panel has this fixed height, adjusted by dragging the
  /// horizontal handle between them. Persisted.
  resultsHeight: number;
  paletteOpen: boolean;
  settingsOpen: boolean;
  /// Whether the connection menu is open (controlled): the empty-state card's
  /// "Connect…" button opens it programmatically; ConnectionMenu binds to this state.
  connectMenuOpen: boolean;
  settings: Settings;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  toggleResults: () => void;
  setResultsVisible: (v: boolean) => void;
  setResultsHeight: (h: number) => void;
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
      resultsHeight: 280,
      paletteOpen: false,
      settingsOpen: false,
      connectMenuOpen: false,
      settings: DEFAULT_SETTINGS,
      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
      // Range 160–680: room for narrow/wide schema names.
      setSidebarWidth: (w) => set({ sidebarWidth: Math.max(160, Math.min(680, w)) }),
      setSidebarTab: (tab) => set({ sidebarTab: tab }),
      toggleResults: () => set((s) => ({ resultsVisible: !s.resultsVisible })),
      setResultsVisible: (v) => set({ resultsVisible: v }),
      setResultsHeight: (h) => set({ resultsHeight: Math.max(80, h) }),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setConnectMenuOpen: (open) => set({ connectMenuOpen: open }),
      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
    }),
    {
      name: "ariadne-ui",
      storage: createJSONStorage(() => localStorage),
      // paletteOpen/settingsOpen are not persisted (start closed each launch).
      partialize: (s) => ({
        sidebarVisible: s.sidebarVisible,
        sidebarWidth: s.sidebarWidth,
        sidebarTab: s.sidebarTab,
        resultsVisible: s.resultsVisible,
        resultsHeight: s.resultsHeight,
        settings: s.settings,
      }),
      // If an older persisted state has no settings, merge with the defaults.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UiState>;
        // A pre-rename persisted value ("activity") is no longer a valid tab → fall back.
        const validTabs: SidebarTab[] = ["explorer", "roles", "history"];
        const sidebarTab = validTabs.includes(p.sidebarTab as SidebarTab)
          ? (p.sidebarTab as SidebarTab)
          : "explorer";
        return {
          ...current,
          ...p,
          sidebarTab,
          settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) },
        };
      },
    },
  ),
);
