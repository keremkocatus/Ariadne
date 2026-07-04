// The startup "bring back yesterday's workspace" invite. Restored tabs carry dead
// connectionIds; this resolves them via the lastSession mapping into (profile,
// database) pairs, filters to profiles that still exist, and shows a persistent
// "Reconnect" toast for each pair. There is NO automatic reconnect (so an offline
// startup doesn't flood with errors); it's a one-click invite.
import { toast } from "sonner";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";
import { useTabsStore } from "@/stores/tabsStore";
import { isAriadneError, type ConnectionProfile } from "@/lib/api";

// Prevents offering a second time in the same startup (StrictMode / repeat calls).
let offered = false;

// How long the invite toast stays up (was Infinity, which got stuck).
const RECONNECT_TOAST_MS = 30_000;

/// A stable id for a (profile, database) invite toast — so they don't stack, and so
/// it can be dismissed when the user connects another way.
export function reconnectToastId(profileId: string, database: string): string {
  return `reconnect:${profileId}:${database}`;
}

/// Dismisses the pending reconnect invite for that (profile, database) — connectProfile
/// calls this when the user connects via the menu.
export function dismissReconnectToast(profileId: string, database: string): void {
  toast.dismiss(reconnectToastId(profileId, database));
}

interface Invite {
  profile: ConnectionProfile;
  database: string;
  oldIds: Set<string>;
}

/// Extracts distinct (profile, database) invites from restored tabs with dead connections.
function collectInvites(): Invite[] {
  const conn = useConnectionStore.getState();
  const tabs = useTabsStore.getState().tabs;
  const byPair = new Map<string, Invite>();
  for (const t of tabs) {
    const cid = t.connectionId;
    if (!cid) continue;
    if (conn.connections[cid]) continue; // already live (shouldn't happen at startup, but be safe)
    const rec = conn.lastSession[cid];
    if (!rec) continue;
    const profile = conn.profiles.find((p) => p.id === rec.profileId);
    if (!profile) continue; // profile was deleted
    const key = `${rec.profileId}::${rec.database}`;
    const inv = byPair.get(key) ?? { profile, database: rec.database, oldIds: new Set() };
    inv.oldIds.add(cid);
    byPair.set(key, inv);
  }
  return [...byPair.values()];
}

/// The reconnect action: connect (or find the existing connection), load the
/// snapshot, move the old-id tabs onto the new connection, forget the consumed
/// session records.
async function reconnectAndRemap(inv: Invite): Promise<void> {
  const conn = useConnectionStore.getState();
  try {
    let newId = conn.findConnection(inv.profile.id, inv.database);
    if (!newId) {
      newId = await conn.connect(inv.profile.id, inv.database);
      await useSchemaStore.getState().loadSnapshot(newId);
    }
    useTabsStore.getState().remapConnection([...inv.oldIds], newId);
    useConnectionStore.getState().setActive(newId);
    useConnectionStore.getState().forgetSession([...inv.oldIds]);
    dismissReconnectToast(inv.profile.id, inv.database);
  } catch (e) {
    toast.error("Could not reconnect", {
      description: isAriadneError(e) ? e.message : String(e),
    });
  }
}

/// Called once at App mount (after profiles load). At most 3 invites (noise limit).
/// Stays silent if there are no matching tabs.
export function offerReconnect(): void {
  if (offered) return;
  offered = true;
  const invites = collectInvites().slice(0, 3);
  for (const inv of invites) {
    const p = inv.profile;
    // Label: profile name + server/database — so the same database name on two
    // servers is disambiguated by host.
    toast(`Reconnect to ${p.name}?`, {
      id: reconnectToastId(p.id, inv.database),
      description: `${p.user}@${p.host}:${p.port} · ${inv.database}`,
      duration: RECONNECT_TOAST_MS,
      closeButton: true,
      action: {
        label: "Reconnect",
        onClick: () => void reconnectAndRemap(inv),
      },
    });
  }
}
