// Bağlantı seçim/geçiş orkestrasyonu (design 15 §P1-U1). ConnectionMenu ve
// CommandPalette bu tek kaynaktan geçer — "üstten seçim dolu tab'ı rebind etmez"
// kuralı burada yaşar.
import { toast } from "sonner";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";
import { useTabsStore, isPristine } from "@/stores/tabsStore";
import { useUiStore } from "@/stores/uiStore";
import { isAriadneError, refreshSchema } from "@/lib/api";
import { dismissReconnectToast } from "@/lib/sessionResume";

// Zaten-bağlı bir bağlantıya geçerken snapshot bu yaştan eskiyse arka planda
// tazelenir (design 15 §P1-U1 madde 4). Eşik ayarlardan gelir (design 15 §P1-U4).
function refreshIfStale(connectionId: string) {
  const entry = useSchemaStore.getState().byConnection[connectionId];
  const snap = entry?.snapshot;
  if (!snap || entry?.status === "loading") return;
  const staleMs = useUiStore.getState().settings.schemaStaleMinutes * 60 * 1000;
  const age = Date.now() - new Date(snap.fetched_at).getTime();
  if (age > staleMs) void refreshSchema(connectionId);
}

/**
 * Üstten bağlantı seçmenin YENİ semantiği (design 15 §P1-U1): dolu bir tab'ı
 * ASLA sessizce rebind etmez. Aktif tab pristine ise (boş, sonuçsuz, idle)
 * yerinde bağlar; değilse o bağlantıya bağlı yeni bir tab açar. Her iki halde
 * "yeni tab varsayılanı" (activeConnectionId) güncellenir ve bayat şema tazelenir.
 */
export function focusConnection(connectionId: string) {
  useConnectionStore.getState().setActive(connectionId);
  const tabs = useTabsStore.getState();
  const active = tabs.tabs.find((t) => t.id === tabs.activeTabId);
  if (active && isPristine(active)) {
    tabs.setConnection(active.id, connectionId);
  } else {
    tabs.addTab(undefined, connectionId);
  }
  refreshIfStale(connectionId);
}

/**
 * Profile bağlan (ya da `databaseOverride` ile aynı sunucuda başka DB'ye),
 * ilk snapshot'ı yükle, sonra `focusConnection` ile odakla. Aynı (profil, DB)
 * zaten bağlıysa yeni bağlantı açmaz — mevcut olana odaklanır (design 15 §P1-U1).
 */
export async function connectProfile(profileId: string, databaseOverride?: string) {
  const conn = useConnectionStore.getState();
  if (databaseOverride) {
    const existing = conn.findConnection(profileId, databaseOverride);
    if (existing) {
      focusConnection(existing);
      dismissReconnectToast(profileId, databaseOverride);
      return;
    }
  }
  try {
    const id = await conn.connect(profileId, databaseOverride);
    await useSchemaStore.getState().loadSnapshot(id);
    focusConnection(id);
    // Bu (profil, DB) için bekleyen reconnect daveti varsa söndür (design 18 §P1-W1
    // N2) — kullanıcı menüden bağlandı, davet artık gereksiz.
    const db = useConnectionStore.getState().connections[id]?.database;
    if (db) dismissReconnectToast(profileId, db);
  } catch (e) {
    toast.error("Could not connect", {
      description: isAriadneError(e) ? e.message : String(e),
    });
  }
}
