// Tauri event köprüsü (design 07 §1): event'ler tek yerde store'lara bağlanır;
// component'ler event bilmez, sadece store'a abone olur.
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useSchemaStore } from "@/stores/schemaStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useTabsStore } from "@/stores/tabsStore";
import type { AriadneError } from "@/lib/api";

interface ConnPayload {
  connection_id: string;
}
interface LostPayload {
  connection_id: string;
  error: AriadneError;
}
interface FrozenPayload {
  connection_id: string;
  tab_id: string;
}

/** Uygulama açılışında bir kez çağrılır; unlisten fonksiyonlarını döndürür. */
export async function registerEventBridge(): Promise<() => void> {
  const unlisteners = await Promise.all([
    listen<ConnPayload>("schema:refresh_started", (e) => {
      useSchemaStore.getState().onRefreshStarted(e.payload.connection_id);
    }),
    listen<ConnPayload>("schema:refreshed", (e) => {
      void useSchemaStore.getState().onRefreshed(e.payload.connection_id);
    }),
    listen<LostPayload>("connection:lost", (e) => {
      toast.error("Connection lost", { description: e.payload.error?.message });
      void useConnectionStore.getState().disconnect(e.payload.connection_id);
      // Bağlı tab'ların tx/running durumunu serbest bırak — aksi halde sunucuda
      // zaten ölmüş bir tx yüzünden o tab'lar sonsuza dek kilitli kalır (design 12
      // §P1-M1: kapalı bağlantı bandındaki "switch" hiçbir zaman izin vermez).
      useTabsStore.getState().releaseTabsForConnection(e.payload.connection_id);
    }),
    listen<FrozenPayload>("result:frozen", (e) => {
      useTabsStore.getState().markFrozen(e.payload.tab_id);
    }),
  ]);

  return () => unlisteners.forEach((u) => u());
}
