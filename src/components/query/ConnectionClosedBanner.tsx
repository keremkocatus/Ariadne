import { toast } from "sonner";
import { useConnectionStore } from "@/stores/connectionStore";
import { useTabsStore } from "@/stores/tabsStore";

interface Props {
  tabId: string;
}

/// Shown when a tab's connection closes (user disconnect or a connection:lost event)
/// — results stay read-only. The tab must be bound to another connection before it
/// can run again.
export function ConnectionClosedBanner({ tabId }: Props) {
  const connections = useConnectionStore((s) => s.connections);
  const profiles = useConnectionStore((s) => s.profiles);
  const setConnection = useTabsStore((s) => s.setConnection);
  const connected = Object.values(connections);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warn/40 bg-warn/5 px-3 py-1.5 text-[11px] text-warn">
      <span>Connection closed for this tab.</span>
      {connected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span>Switch to:</span>
          {connected.map((c) => {
            // Label by profile name (not just the database) so two servers that both
            // expose e.g. a `postgres` database are distinguishable; the tooltip carries
            // the full user@host:port/database coordinates.
            const p = profiles.find((pr) => pr.id === c.profile_id);
            const label = p ? `${p.name} · ${c.database}` : c.database;
            const coords = p ? `${c.user}@${p.host}:${p.port}/${c.database}` : c.database;
            return (
              <button
                key={c.connection_id}
                title={coords}
                className="rounded border border-warn/40 px-1.5 py-0.5 hover:bg-warn/10"
                onClick={() => {
                  if (!setConnection(tabId, c.connection_id)) {
                    toast.error("Can't switch this tab's connection", {
                      description: "Finish the running query, open transaction, or pending results first.",
                    });
                  }
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : (
        <span className="text-fg-muted">Connect to a database from the toolbar, then switch this tab to it.</span>
      )}
    </div>
  );
}
