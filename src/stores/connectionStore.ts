import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import * as api from "@/lib/api";
import type { ConnectionInfo, ConnectionProfile, ProfileInput } from "@/lib/api";

/// Son oturumda hangi connectionId'nin hangi (profil, DB)'ye çözüldüğü (design 17
/// §P1-V3). Canlı bağlantılar persist EDİLMEZ; yalnız bu eşleme kalır, böylece
/// açılışta ölü connectionId taşıyan restore edilmiş tab'lar için "reconnect"
/// daveti üretilebilir. Budama: 50 kayıt (ekleme sırasına göre eskiler atılır).
type SessionMap = Record<string, { profileId: string; database: string }>;
const SESSION_LIMIT = 50;

interface ConnectionState {
  profiles: ConnectionProfile[];
  /** connection_id → aktif bağlantı bilgisi */
  connections: Record<string, ConnectionInfo>;
  activeConnectionId: string | null;
  /** connection_id → (profil, DB) — sadece bu alan persist edilir (bkz. yukarı). */
  lastSession: SessionMap;

  loadProfiles: () => Promise<void>;
  saveProfile: (p: ProfileInput, password?: string) => Promise<ConnectionProfile>;
  deleteProfile: (id: string) => Promise<void>;

  connect: (profileId: string, databaseOverride?: string) => Promise<string>;
  disconnect: (connectionId: string) => Promise<void>;
  setActive: (connectionId: string | null) => void;
  /// Reconnect + remap sonrası tüketilen eski oturum kayıtlarını unutur (design 17 §P1-V3).
  forgetSession: (connectionIds: string[]) => void;

  activeInfo: () => ConnectionInfo | null;
  /// (profil, DB) çiftine zaten bağlı bir bağlantı varsa id'sini döndürür (design
  /// 15 §P1-U1 — aynı DB'ye ikinci pool açmamak için).
  findConnection: (profileId: string, database: string) => string | null;
  /// Bağlantının profili read-only mi (design 17 §P1-V1 Ö5). Profil silinmişse
  /// false — rozet kaybolur, zarar yok.
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
      // Canlı kaynaklar (connections/activeConnectionId/profiles) ASLA persist
      // edilmez — yalnız oturum eşlemesi (design 17 §P1-V3).
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
