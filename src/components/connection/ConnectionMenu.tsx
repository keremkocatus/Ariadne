import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Pencil, Plus, Plug, Unplug } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";
import { isAriadneError, type ConnectionProfile } from "@/lib/api";
import { ProfileDialog } from "./ProfileDialog";

export function ConnectionMenu() {
  const { profiles, connections, activeConnectionId, loadProfiles, connect, disconnect, setActive } =
    useConnectionStore();
  const activeInfo = useConnectionStore((s) => s.activeInfo());
  const loadSnapshot = useSchemaStore((s) => s.loadSnapshot);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionProfile | null>(null);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  async function doConnect(profileId: string) {
    try {
      const id = await connect(profileId);
      await loadSnapshot(id); // ilk snapshot (arka plan refresh sonrası event tazeler)
    } catch (e) {
      toast.error("Could not connect", { description: isAriadneError(e) ? e.message : String(e) });
    }
  }

  const activeProfile = profiles.find((p) => p.id === activeInfo?.profile_id);
  const label = activeInfo ? activeProfile?.name ?? activeInfo.database : "No connection";

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="inline-flex items-center gap-2 rounded border border-border bg-bg-elev px-2.5 py-1 text-xs hover:border-fg-muted">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: activeInfo?.color || (activeInfo ? "#4ade80" : "#3a3a3a") }}
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
                      c.connection_id === activeConnectionId && "bg-bg",
                    )}
                  >
                    <button
                      className="flex flex-1 items-center gap-2 text-left"
                      onClick={() => setActive(c.connection_id)}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ background: c.color || "#4ade80" }} />
                      <span className="truncate">
                        {profiles.find((p) => p.id === c.profile_id)?.name ?? c.database}
                      </span>
                    </button>
                    <button
                      title="Disconnect"
                      className="text-fg-muted hover:text-danger"
                      onClick={() => void disconnect(c.connection_id)}
                    >
                      <Unplug size={13} />
                    </button>
                  </div>
                ))}
                <Separator />
              </>
            )}

            <SectionLabel>Profiles</SectionLabel>
            {profiles.length === 0 && <div className="px-2 py-1 text-fg-muted">No profiles yet</div>}
            {profiles.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded px-2 py-1 hover:bg-bg">
                <button className="flex flex-1 items-center gap-2 text-left" onClick={() => void doConnect(p.id)}>
                  <Plug size={12} className="text-fg-muted" />
                  <span className="truncate">{p.name}</span>
                  <span className="truncate text-fg-muted">
                    {p.user}@{p.host}
                  </span>
                </button>
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

      <ProfileDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        existing={editing}
        onSaved={(id) => void doConnect(id)}
      />
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-fg-muted">{children}</div>;
}
function Separator() {
  return <div className="my-1 h-px bg-border" />;
}
