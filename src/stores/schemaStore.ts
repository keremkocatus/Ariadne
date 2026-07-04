import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import * as api from "@/lib/api";
import type { SchemaSnapshot } from "@/lib/api";

type SchemaStatus = "idle" | "loading" | "ready" | "error";

interface SchemaEntry {
  status: SchemaStatus;
  snapshot?: SchemaSnapshot;
}

/// Explorer group filter: name substring + kind selection. Empty `kinds` means all
/// kinds. Kept separately for Tables and Functions.
export interface CategoryFilter {
  name: string;
  kinds: string[];
}
export interface ExplorerFilter {
  rel: CategoryFilter;
  fn: CategoryFilter;
}
export const EMPTY_FILTER: ExplorerFilter = {
  rel: { name: "", kinds: [] },
  fn: { name: "", kinds: [] },
};
export function isCategoryActive(f: CategoryFilter): boolean {
  return f.name.trim() !== "" || f.kinds.length > 0;
}

interface SchemaState {
  byConnection: Record<string, SchemaEntry>;
  /** Pins per profile: profileId → ["public.users", ...] (persisted) */
  pins: Record<string, string[]>;
  search: string;
  /** Explorer filter per connection (session-only, not persisted) */
  filters: Record<string, ExplorerFilter>;

  loadSnapshot: (connectionId: string) => Promise<void>;
  onRefreshStarted: (connectionId: string) => void;
  onRefreshed: (connectionId: string) => Promise<void>;

  setSearch: (q: string) => void;
  togglePin: (profileId: string, qualified: string) => void;
  isPinned: (profileId: string, qualified: string) => boolean;

  getFilter: (connectionId: string | null) => ExplorerFilter;
  setFilter: (connectionId: string, which: "rel" | "fn", patch: Partial<CategoryFilter>) => void;
  clearFilter: (connectionId: string, which: "rel" | "fn") => void;

  entry: (connectionId: string | null) => SchemaEntry | undefined;
}

export const useSchemaStore = create<SchemaState>()(
  persist(
    (set, get) => ({
      byConnection: {},
      pins: {},
      search: "",
      filters: {},

      async loadSnapshot(connectionId) {
        set((s) => ({
          byConnection: {
            ...s.byConnection,
            [connectionId]: { status: "loading", snapshot: s.byConnection[connectionId]?.snapshot },
          },
        }));
        try {
          const snapshot = await api.getSchemaSnapshot(connectionId);
          set((s) => ({
            byConnection: { ...s.byConnection, [connectionId]: { status: "ready", snapshot } },
          }));
        } catch {
          set((s) => ({
            byConnection: {
              ...s.byConnection,
              [connectionId]: { status: "error", snapshot: s.byConnection[connectionId]?.snapshot },
            },
          }));
        }
      },

      onRefreshStarted(connectionId) {
        set((s) => ({
          byConnection: {
            ...s.byConnection,
            [connectionId]: { status: "loading", snapshot: s.byConnection[connectionId]?.snapshot },
          },
        }));
      },

      async onRefreshed(connectionId) {
        await get().loadSnapshot(connectionId);
      },

      setSearch(q) {
        set({ search: q });
      },

      togglePin(profileId, qualified) {
        set((s) => {
          const cur = s.pins[profileId] ?? [];
          const next = cur.includes(qualified)
            ? cur.filter((x) => x !== qualified)
            : [...cur, qualified];
          return { pins: { ...s.pins, [profileId]: next } };
        });
      },

      isPinned(profileId, qualified) {
        return (get().pins[profileId] ?? []).includes(qualified);
      },

      getFilter(connectionId) {
        return (connectionId ? get().filters[connectionId] : undefined) ?? EMPTY_FILTER;
      },

      setFilter(connectionId, which, patch) {
        set((s) => {
          const cur = s.filters[connectionId] ?? EMPTY_FILTER;
          return {
            filters: {
              ...s.filters,
              [connectionId]: { ...cur, [which]: { ...cur[which], ...patch } },
            },
          };
        });
      },

      clearFilter(connectionId, which) {
        set((s) => {
          const cur = s.filters[connectionId] ?? EMPTY_FILTER;
          return {
            filters: {
              ...s.filters,
              [connectionId]: { ...cur, [which]: { name: "", kinds: [] } },
            },
          };
        });
      },

      entry(connectionId) {
        return connectionId ? get().byConnection[connectionId] : undefined;
      },
    }),
    {
      name: "ariadne-schema",
      storage: createJSONStorage(() => localStorage),
      // Only pins are persisted; snapshots/searches are session-only.
      partialize: (s) => ({ pins: s.pins }) as SchemaState,
    },
  ),
);
