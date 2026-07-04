import { create } from "zustand";
import * as api from "@/lib/api";
import type { ConnectionInfo, ConnectionProfile, ProfileInput } from "@/lib/api";

interface ConnectionState {
  profiles: ConnectionProfile[];
  /** connection_id → aktif bağlantı bilgisi */
  connections: Record<string, ConnectionInfo>;
  activeConnectionId: string | null;

  loadProfiles: () => Promise<void>;
  saveProfile: (p: ProfileInput, password?: string) => Promise<ConnectionProfile>;
  deleteProfile: (id: string) => Promise<void>;

  connect: (profileId: string, databaseOverride?: string) => Promise<string>;
  disconnect: (connectionId: string) => Promise<void>;
  setActive: (connectionId: string | null) => void;

  activeInfo: () => ConnectionInfo | null;
  /// (profil, DB) çiftine zaten bağlı bir bağlantı varsa id'sini döndürür (design
  /// 15 §P1-U1 — aynı DB'ye ikinci pool açmamak için).
  findConnection: (profileId: string, database: string) => string | null;
  /// Bağlantının profili read-only mi (design 17 §P1-V1 Ö5). Profil silinmişse
  /// false — rozet kaybolur, zarar yok.
  isReadOnly: (connectionId: string | null) => boolean;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  profiles: [],
  connections: {},
  activeConnectionId: null,

  async loadProfiles() {
    set({ profiles: await api.listProfiles() });
  },

  async saveProfile(p, password) {
    const saved = await api.saveProfile(p, password);
    await get().loadProfiles();
    return saved;
  },

  async deleteProfile(id) {
    await api.deleteProfile(id);
    await get().loadProfiles();
  },

  async connect(profileId, databaseOverride) {
    const info = await api.connect(profileId, databaseOverride);
    set((s) => ({
      connections: { ...s.connections, [info.connection_id]: info },
      activeConnectionId: info.connection_id,
    }));
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
}));
