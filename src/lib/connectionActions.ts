// Orchestration for choosing/switching connections. ConnectionMenu and
// CommandPalette both go through this single source — the rule "the top menu doesn't
// rebind a non-empty tab" lives here.
import { toast } from "sonner";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";
import { useTabsStore, isPristine } from "@/stores/tabsStore";
import { useUiStore } from "@/stores/uiStore";
import { isAriadneError, refreshSchema } from "@/lib/api";
import { dismissReconnectToast } from "@/lib/sessionResume";

// When switching to an already-connected connection, refresh in the background if the
// snapshot is older than the threshold. The threshold comes from settings.
function refreshIfStale(connectionId: string) {
  const entry = useSchemaStore.getState().byConnection[connectionId];
  const snap = entry?.snapshot;
  if (!snap || entry?.status === "loading") return;
  const staleMs = useUiStore.getState().settings.schemaStaleMinutes * 60 * 1000;
  const age = Date.now() - new Date(snap.fetched_at).getTime();
  if (age > staleMs) void refreshSchema(connectionId);
}

/**
 * The semantics of choosing a connection from the top menu: it NEVER silently
 * rebinds a non-empty tab. If the active tab is pristine (empty, no result, idle) it
 * rebinds in place; otherwise it opens a new tab bound to that connection. Either
 * way the "new tab default" (activeConnectionId) is updated and a stale schema is
 * refreshed.
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
 * Connect to a profile (or, with `databaseOverride`, to another database on the same
 * server), load the first snapshot, then focus it via `focusConnection`. If the same
 * (profile, database) is already connected, it doesn't open a new connection — it
 * focuses the existing one.
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
    // Dismiss any pending reconnect invite for this (profile, database) — the user
    // just connected via the menu, so the invite is no longer needed.
    const db = useConnectionStore.getState().connections[id]?.database;
    if (db) dismissReconnectToast(profileId, db);
  } catch (e) {
    toast.error("Could not connect", {
      description: isAriadneError(e) ? e.message : String(e),
    });
  }
}
