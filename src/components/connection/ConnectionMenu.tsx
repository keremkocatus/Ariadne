import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ChevronRight, Database, Pencil, Plus, Plug, Trash2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connectionStore";
import { useTabsStore } from "@/stores/tabsStore";
import { useUiStore } from "@/stores/uiStore";
import {
  isAriadneError,
  listDatabases,
  type ConnectionInfo,
  type ConnectionProfile,
  type DatabaseInfo,
} from "@/lib/api";
import { connectProfile, focusConnection } from "@/lib/connectionActions";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ProfileDialog } from "./ProfileDialog";
import { RoBadge } from "./RoBadge";

export function ConnectionMenu() {
  const { profiles, connections, loadProfiles, disconnect, deleteProfile } = useConnectionStore();
  // The button/label/highlight reflect the connection the active TAB is actually
  // bound to, not the global activeConnectionId — the same source as StatusBar.
  const tabConnectionId = useTabsStore((s) => s.active()?.connectionId ?? null);
  const tabInfo = tabConnectionId ? (connections[tabConnectionId] ?? null) : null;

  // The open state is in uiStore so the empty-state card's "Connect…" button can open
  // the menu programmatically.
  const menuOpen = useUiStore((s) => s.connectMenuOpen);
  const setMenuOpen = useUiStore((s) => s.setConnectMenuOpen);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionProfile | null>(null);
  const [deleting, setDeleting] = useState<ConnectionProfile | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Live connections of the profile pending deletion — closed as part of delete.
  const deletingLive = deleting
    ? Object.values(connections).filter((c) => c.profile_id === deleting.id)
    : [];

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      for (const c of deletingLive) {
        await disconnect(c.connection_id);
        // Release the tx/running state of the attached tabs (same as manual disconnect).
        useTabsStore.getState().releaseTabsForConnection(c.connection_id);
      }
      await deleteProfile(deleting.id);
      toast.success(`Deleted "${deleting.name}"`);
      setDeleting(null);
    } catch (e) {
      toast.error("Could not delete profile", {
        description: isAriadneError(e) ? e.message : String(e),
      });
    } finally {
      setDeleteBusy(false);
    }
  };

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  // Choosing from the top menu no longer rebinds a non-empty tab: if pristine it binds
  // in place, otherwise it opens a new tab — all handled in focusConnection/connectProfile.
  const pick = (fn: () => void) => {
    fn();
    setMenuOpen(false);
  };

  const activeProfile = profiles.find((p) => p.id === tabInfo?.profile_id);
  const label = tabInfo ? activeProfile?.name ?? tabInfo.database : "No connection";

  return (
    <>
      <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger asChild>
          <button className="inline-flex items-center gap-2 rounded border border-border bg-bg-elev px-2.5 py-1 text-xs hover:border-fg-muted">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: tabInfo?.color || (tabInfo ? "#4ade80" : "#3a3a3a") }}
            />
            <span className="max-w-[160px] truncate">{label}</span>
            <ChevronDown size={12} className="text-fg-muted" />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            className="z-50 min-w-[240px] rounded-md border border-border bg-bg-elev p-1 text-xs shadow-2xl"
          >
            {Object.values(connections).length > 0 && (
              <>
                <SectionLabel>Connected</SectionLabel>
                {Object.values(connections).map((c) => (
                  <div
                    key={c.connection_id}
                    className={cn(
                      "flex items-center justify-between rounded px-2 py-1 hover:bg-bg",
                      c.connection_id === tabConnectionId && "bg-bg",
                    )}
                  >
                    <button
                      className="flex flex-1 items-center gap-2 overflow-hidden text-left"
                      onClick={() => pick(() => focusConnection(c.connection_id))}
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.color || "#4ade80" }} />
                      <span className="truncate">
                        {profiles.find((p) => p.id === c.profile_id)?.name ?? c.database}
                      </span>
                      <span className="truncate text-fg-muted">{c.database}</span>
                      {profiles.find((p) => p.id === c.profile_id)?.read_only && <RoBadge className="shrink-0" />}
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <DatabasesSubmenu conn={c} onPick={setMenuOpen} />
                      <button
                        title="Disconnect"
                        className="rounded p-0.5 text-fg-muted hover:text-danger"
                        onClick={() => {
                          void disconnect(c.connection_id);
                          // Release the tx/running state of the attached tabs
                          // (otherwise a tab with an open tx stays locked forever).
                          useTabsStore.getState().releaseTabsForConnection(c.connection_id);
                        }}
                      >
                        <Unplug size={13} />
                      </button>
                    </div>
                  </div>
                ))}
                <Separator />
              </>
            )}

            <SectionLabel>Profiles</SectionLabel>
            {profiles.length === 0 && <div className="px-2 py-1 text-fg-muted">No profiles yet</div>}
            {profiles.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded px-2 py-1 hover:bg-bg">
                <button
                  className="flex flex-1 items-center gap-2 overflow-hidden text-left"
                  onClick={() => pick(() => void connectProfile(p.id))}
                >
                  <Plug size={12} className="shrink-0 text-fg-muted" />
                  <span className="truncate">{p.name}</span>
                  <span className="truncate text-fg-muted">
                    {p.user}@{p.host}
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    title="Edit"
                    className="text-fg-muted hover:text-fg"
                    onClick={() => {
                      setEditing(p);
                      setDialogOpen(true);
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    title="Delete"
                    className="text-fg-muted hover:text-danger"
                    onClick={() => setDeleting(p)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}

            <Separator />
            <DropdownMenu.Item
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 outline-none hover:bg-bg"
              onSelect={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus size={13} /> New connection…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Mounted only while open so each open re-initializes the form from `existing`
          (a permanently mounted dialog kept stale values across edit/new switches). */}
      {dialogOpen && (
        <ProfileDialog
          open
          onOpenChange={setDialogOpen}
          existing={editing}
          onSaved={(id) => void connectProfile(id)}
        />
      )}

      {deleting && (
        <Dialog open onOpenChange={(o) => !o && !deleteBusy && setDeleting(null)}>
          <DialogContent className="w-[400px]">
            <DialogTitle>Delete connection profile</DialogTitle>
            <DialogDescription>
              "{deleting.name}" and its stored password will be removed.
              {deletingLive.length > 0 &&
                ` ${deletingLive.length} active connection${deletingLive.length > 1 ? "s" : ""} to this profile will be closed.`}
            </DialogDescription>
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => setDeleting(null)} disabled={deleteBusy}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void confirmDelete()} disabled={deleteBusy}>
                {deleteBusy ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/// A connected connection's "Databases ▸" submenu: the list is fetched lazily when
/// opened; selecting a database opens a new connection to it on the same server (or
/// focuses an existing one) and runs in its new tab.
function DatabasesSubmenu({ conn, onPick }: { conn: ConnectionInfo; onPick: (open: boolean) => void }) {
  const [dbs, setDbs] = useState<DatabaseInfo[] | null>(null);
  const [error, setError] = useState(false);

  const load = () => {
    setError(false);
    setDbs(null);
    listDatabases(conn.connection_id)
      .then(setDbs)
      .catch(() => setError(true));
  };

  return (
    <DropdownMenu.Sub onOpenChange={(open) => open && load()}>
      <DropdownMenu.SubTrigger
        title="Switch database"
        className="flex items-center gap-0.5 rounded p-0.5 text-fg-muted outline-none hover:text-fg data-[state=open]:text-fg"
        onClick={(e) => e.stopPropagation()}
      >
        <Database size={12} />
        <ChevronRight size={11} />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          sideOffset={4}
          className="z-50 max-h-[320px] min-w-[180px] overflow-auto rounded-md border border-border bg-bg-elev p-1 text-xs shadow-2xl"
        >
          {error ? (
            <div className="px-2 py-1 text-danger">Couldn't list databases</div>
          ) : dbs === null ? (
            <div className="px-2 py-1 text-fg-muted">Loading…</div>
          ) : dbs.length === 0 ? (
            <div className="px-2 py-1 text-fg-muted">No databases</div>
          ) : (
            dbs.map((d) => (
              <DropdownMenu.Item
                key={d.name}
                disabled={d.is_current}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded px-2 py-1 outline-none hover:bg-bg data-[disabled]:cursor-default data-[disabled]:opacity-50",
                )}
                onSelect={() => {
                  onPick(false);
                  void connectProfile(conn.profile_id, d.name);
                }}
              >
                <Database size={11} className="shrink-0 text-fg-muted" />
                <span className="truncate">{d.name}</span>
                {d.is_current && <span className="ml-auto text-[10px] text-fg-muted">current</span>}
              </DropdownMenu.Item>
            ))
          )}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-fg-muted">{children}</div>;
}
function Separator() {
  return <div className="my-1 h-px bg-border" />;
}
