import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import * as api from "@/lib/api";
import type { SchemaSnapshot } from "@/lib/api";

type SchemaStatus = "idle" | "loading" | "ready" | "error";

interface SchemaEntry {
  status: SchemaStatus;
  snapshot?: SchemaSnapshot;
}

interface SchemaState {
  byConnection: Record<string, SchemaEntry>;
  /** profil bazında pin'ler: profileId → ["public.users", ...] (kalıcı) */
  pins: Record<string, string[]>;
  search: string;

  loadSnapshot: (connectionId: string) => Promise<void>;
  onRefreshStarted: (connectionId: string) => void;
  onRefreshed: (connectionId: string) => Promise<void>;

  setSearch: (q: string) => void;
  togglePin: (profileId: string, qualified: string) => void;
  isPinned: (profileId: string, qualified: string) => boolean;

  entry: (connectionId: string | null) => SchemaEntry | undefined;
}

export const useSchemaStore = create<SchemaState>()(
  persist(
    (set, get) => ({
      byConnection: {},
      pins: {},
      search: "",

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

      entry(connectionId) {
        return connectionId ? get().byConnection[connectionId] : undefined;
      },
    }),
    {
      name: "ariadne-schema",
      storage: createJSONStorage(() => localStorage),
      // Sadece pin'ler kalıcı; snapshot'lar/aramalar oturumluk.
      partialize: (s) => ({ pins: s.pins }) as SchemaState,
    },
  ),
);
