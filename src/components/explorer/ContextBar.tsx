// The Explorer context bar: `server ▸ database ▾`. A shallow take on SQL Server's
// Object Explorer — it moves database switching into the Explorer, out of the top
// ConnectionMenu's clunky database submenu. Right-click → New query.
import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Database, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connectionStore";
import { useTabsStore } from "@/stores/tabsStore";
import { listDatabases, refreshSchema, type DatabaseInfo } from "@/lib/api";
import { connectProfile } from "@/lib/connectionActions";
import { RoBadge } from "@/components/connection/RoBadge";
import { QuickActionMenu } from "./QuickActionMenu";

export function ContextBar({ connectionId }: { connectionId: string | null }) {
  const info = useConnectionStore((s) => (connectionId ? s.connections[connectionId] ?? null : null));
  const readOnly = useConnectionStore((s) => s.isReadOnly(connectionId));
  const profile = useConnectionStore((s) =>
    info ? s.profiles.find((p) => p.id === info.profile_id) ?? null : null,
  );
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  if (!connectionId || !info) {
    return (
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border px-2 text-[11px] text-fg-muted">
        <Server size={11} /> No connection
      </div>
    );
  }

  const serverName = profile?.name ?? info.database;
  const newQuery = () => useTabsStore.getState().addTab("", connectionId);

  return (
    <>
      <div
        className="flex h-6 shrink-0 items-center gap-1 border-b border-border px-2 text-[11px]"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={`${info.user}@${profile?.host ?? "?"}:${profile?.port ?? "?"}`}
      >
        <Server size={11} className="shrink-0 text-fg-muted" />
        <span className="max-w-[120px] truncate">{serverName}</span>
        {readOnly && <RoBadge />}
        <span className="text-fg-muted">▸</span>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="inline-flex items-center gap-1 rounded px-1 hover:bg-bg-elev">
              <Database size={11} className="shrink-0 text-fg-muted" />
              <span className="max-w-[110px] truncate">{info.database}</span>
              <ChevronDown size={10} className="text-fg-muted" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={4}
              className="z-50 max-h-[320px] min-w-[180px] overflow-auto rounded-md border border-border bg-bg-elev p-1 text-xs shadow-2xl"
            >
              <DatabaseList
                connectionId={connectionId}
                profileId={info.profile_id}
                current={info.database}
              />
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {menu && (
        <QuickActionMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          actions={[
            { label: "New query (Ctrl+N)", onClick: newQuery },
            { label: "Refresh schema", onClick: () => void refreshSchema(connectionId) },
          ]}
        />
      )}
    </>
  );
}

/// The database dropdown content: lazy `list_databases` on open; the current database
/// is marked/disabled. Selecting one switches to that database on the same server.
function DatabaseList({
  connectionId,
  profileId,
  current,
}: {
  connectionId: string;
  profileId: string;
  current: string;
}) {
  const [dbs, setDbs] = useState<DatabaseInfo[] | null>(null);
  const [error, setError] = useState(false);

  // Lazily fetch once when the Radix Content mounts (menu opened).
  useEffect(() => {
    let alive = true;
    listDatabases(connectionId)
      .then((d) => alive && setDbs(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [connectionId]);

  if (error) return <div className="px-2 py-1 text-danger">Couldn't list databases</div>;
  if (dbs === null) return <div className="px-2 py-1 text-fg-muted">Loading…</div>;
  if (dbs.length === 0) return <div className="px-2 py-1 text-fg-muted">No databases</div>;

  return (
    <>
      {dbs.map((d) => {
        const isCurrent = d.name === current;
        return (
          <DropdownMenu.Item
            key={d.name}
            disabled={isCurrent}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded px-2 py-1 outline-none hover:bg-bg data-[disabled]:cursor-default data-[disabled]:opacity-60",
            )}
            onSelect={() => !isCurrent && void connectProfile(profileId, d.name)}
          >
            <Database size={11} className="shrink-0 text-fg-muted" />
            <span className="truncate">{d.name}</span>
            {isCurrent && <span className="ml-auto text-[10px] text-fg-muted">current</span>}
          </DropdownMenu.Item>
        );
      })}
    </>
  );
}
