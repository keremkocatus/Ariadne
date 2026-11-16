import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/// User settings. Deliberately minimal for now; could move to a local store later.
/// Persisted in localStorage.
export type Theme = "dark" | "light";

/// A saved query bound to Ctrl+<digit>. An empty `sql` means the slot is unused.
export interface Snippet {
  name: string;
  sql: string;
}
/// Slots are indexed in keyboard order: index 0 is Ctrl+1 … index 9 is Ctrl+0.
export const SNIPPET_SLOTS = 10;
/// The digit key that triggers a slot.
export function snippetKey(slot: number): string {
  return String((slot + 1) % 10);
}
function emptySnippets(): Snippet[] {
  return Array.from({ length: SNIPPET_SLOTS }, () => ({ name: "", sql: "" }));
}

export interface Settings {
  /** Editor font size (px). */
  editorFontSize: number;
  /** Threshold (minutes) after which a schema is considered "stale" when switching to
   *  an already-connected connection. */
  schemaStaleMinutes: number;
  /** If a background tab's query exceeds this many seconds, show a finish toast.
   *  0 = off. */
  longQueryNoticeSeconds: number;
  /** UI color theme. Applied via a `data-theme` attribute on the document root. */
  theme: Theme;
  /** Id of the brand mark shown in the toolbar and as the window icon. */
  logo: string;
  /** Saved queries run with Ctrl+1 … Ctrl+0. */
  snippets: Snippet[];
}
export const DEFAULT_SETTINGS: Settings = {
  editorFontSize: 13,
  schemaStaleMinutes: 5,
  longQueryNoticeSeconds: 10,
  theme: "dark",
  logo: "weaver",
  snippets: emptySnippets(),
};

/// The left panel's active tab. Kept in uiStore so the palette can switch it
/// programmatically.
export type SidebarTab = "explorer" | "roles" | "history";

/// The relation shown in the Details view. Carries its connection so the view stays
/// on the right database when the active tab changes underneath it.
export interface DetailsTarget {
  connectionId: string;
  schema: string;
  name: string;
}

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
  snippetsOpen: boolean;
  cronOpen: boolean;
  detailsTarget: DetailsTarget | null;
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
  setSnippetsOpen: (open: boolean) => void;
  setCronOpen: (open: boolean) => void;
  setDetailsTarget: (target: DetailsTarget | null) => void;
  setConnectMenuOpen: (open: boolean) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  setSnippet: (slot: number, snippet: Snippet) => void;
}

/// Persisted snippets may come from an older build or be hand-edited: coerce to
/// exactly SNIPPET_SLOTS well-formed entries.
function normalizeSnippets(raw: unknown): Snippet[] {
  const list = Array.isArray(raw) ? raw : [];
  return emptySnippets().map((empty, i) => {
    const s = list[i] as Partial<Snippet> | undefined;
    return {
      name: typeof s?.name === "string" ? s.name : empty.name,
      sql: typeof s?.sql === "string" ? s.sql : empty.sql,
    };
  });
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
      snippetsOpen: false,
      cronOpen: false,
      detailsTarget: null,
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
      setSnippetsOpen: (open) => set({ snippetsOpen: open }),
      setCronOpen: (open) => set({ cronOpen: open }),
      setDetailsTarget: (target) => set({ detailsTarget: target }),
      setConnectMenuOpen: (open) => set({ connectMenuOpen: open }),
      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      setSnippet: (slot, snippet) =>
        set((s) => ({
          settings: {
            ...s.settings,
            snippets: s.settings.snippets.map((cur, i) => (i === slot ? snippet : cur)),
          },
        })),
    }),
    {
      name: "ariadne-ui",
      storage: createJSONStorage(() => localStorage),
      // Open/closed state of dialogs is not persisted (they start closed each launch).
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
        const settings = { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) };
        return {
          ...current,
          ...p,
          sidebarTab,
          settings: { ...settings, snippets: normalizeSnippets(settings.snippets) },
        };
      },
    },
  ),
);
