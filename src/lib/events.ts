// Tauri event bridge: events are wired to stores in one place, so components don't
// know about events — they just subscribe to the store.
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

/** Called once at app startup; returns a function that unregisters all listeners. */
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
      // Release the tx/running state of the attached tabs — otherwise a transaction
      // that's already dead server-side leaves those tabs locked forever (the "switch"
      // on the closed-connection banner would never be allowed).
      useTabsStore.getState().releaseTabsForConnection(e.payload.connection_id);
    }),
    listen<FrozenPayload>("result:frozen", (e) => {
      useTabsStore.getState().markFrozen(e.payload.tab_id);
    }),
  ]);

  return () => unlisteners.forEach((u) => u());
}
