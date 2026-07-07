import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import * as api from "@/lib/api";
import type { ConnectionInfo, ConnectionProfile, ProfileInput } from "@/lib/api";

/// Which connectionId resolved to which (profile, database) in the last session.
/// Live connections are NOT persisted; only this mapping survives, so at startup a
/// "reconnect" invite can be produced for restored tabs that carry dead connectionIds.
/// Pruned to 50 entries (oldest by insertion order are dropped).
type SessionMap = Record<string, { profileId: string; database: string }>;
const SESSION_LIMIT = 50;

interface ConnectionState {
  profiles: ConnectionProfile[];
  /** connection_id → active connection info */
  connections: Record<string, ConnectionInfo>;
  activeConnectionId: string | null;
  /** connection_id → (profile, database) — only this field is persisted (see above). */
  lastSession: SessionMap;

  loadProfiles: () => Promise<void>;
  saveProfile: (
    p: ProfileInput,
    password?: string,
    clearPassword?: boolean,
  ) => Promise<ConnectionProfile>;
  deleteProfile: (id: string) => Promise<void>;

  connect: (profileId: string, databaseOverride?: string) => Promise<string>;
  disconnect: (connectionId: string) => Promise<void>;
  setActive: (connectionId: string | null) => void;
  /// Forgets the consumed old-session records after reconnect + remap.
  forgetSession: (connectionIds: string[]) => void;

  activeInfo: () => ConnectionInfo | null;
  /// If a connection to this (profile, database) pair already exists, returns its id
  /// (to avoid opening a second pool to the same database).
  findConnection: (profileId: string, database: string) => string | null;
  /// Whether the connection's profile is read-only. False if the profile was deleted
  /// — the badge disappears, no harm done.
  isReadOnly: (connectionId: string | null) => boolean;
}

export const useConnectionStore = create<ConnectionState>()(
  persist(
    (set, get) => ({
      profiles: [],
      connections: {},
      activeConnectionId: null,
      lastSession: {},

      async loadProfiles() {
        set({ profiles: await api.listProfiles() });
      },

      async saveProfile(p, password, clearPassword) {
        const saved = await api.saveProfile(p, password, clearPassword);
        await get().loadProfiles();
        return saved;
      },

      async deleteProfile(id) {
        await api.deleteProfile(id);
        await get().loadProfiles();
      },

      async connect(profileId, databaseOverride) {
        const info = await api.connect(profileId, databaseOverride);
        set((s) => {
          const lastSession: SessionMap = {
            ...s.lastSession,
            [info.connection_id]: { profileId, database: info.database },
          };
          const keys = Object.keys(lastSession);
          if (keys.length > SESSION_LIMIT) {
            for (const k of keys.slice(0, keys.length - SESSION_LIMIT)) delete lastSession[k];
          }
          return {
            connections: { ...s.connections, [info.connection_id]: info },
            activeConnectionId: info.connection_id,
            lastSession,
          };
        });
        return info.connection_id;
      },

      async disconnect(connectionId) {
        await api.disconnect(connectionId);
        set((s) => {
          const connections = { ...s.connections };
          delete connections[connectionId];
          const activeConnectionId =
            s.activeConnectionId === connectionId
              ? (Object.keys(connections)[0] ?? null)
              : s.activeConnectionId;
          return { connections, activeConnectionId };
        });
      },

      setActive(connectionId) {
        set({ activeConnectionId: connectionId });
      },

      forgetSession(connectionIds) {
        set((s) => {
          const lastSession = { ...s.lastSession };
          for (const id of connectionIds) delete lastSession[id];
          return { lastSession };
        });
      },

      activeInfo() {
        const { activeConnectionId, connections } = get();
        return activeConnectionId ? (connections[activeConnectionId] ?? null) : null;
      },

      findConnection(profileId, database) {
        const found = Object.values(get().connections).find(
          (c) => c.profile_id === profileId && c.database === database,
        );
        return found?.connection_id ?? null;
      },

      isReadOnly(connectionId) {
        if (!connectionId) return false;
        const info = get().connections[connectionId];
        if (!info) return false;
        return get().profiles.find((p) => p.id === info.profile_id)?.read_only ?? false;
      },
    }),
    {
      // Live resources (connections/activeConnectionId/profiles) are NEVER persisted
      // — only the session mapping.
      name: "ariadne-connections",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ lastSession: s.lastSession }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as { lastSession?: SessionMap };
        return { ...current, lastSession: p.lastSession ?? {} };
      },
    },
  ),
);
