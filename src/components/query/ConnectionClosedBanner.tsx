import { toast } from "sonner";
import { useConnectionStore } from "@/stores/connectionStore";
import { useTabsStore } from "@/stores/tabsStore";

interface Props {
  tabId: string;
}

/// Tab'ın bağlı olduğu bağlantı kapandığında gösterilir (kullanıcı disconnect'i ya
/// da connection:lost event'i) — sonuçlar salt-okunur kalır (design 12 §P1-M1 item 5).
/// Yeniden çalıştırmadan önce tab başka bir bağlantıya bağlanmalı.
export function ConnectionClosedBanner({ tabId }: Props) {
  const connections = useConnectionStore((s) => s.connections);
  const setConnection = useTabsStore((s) => s.setConnection);
  const connected = Object.values(connections);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warn/40 bg-warn/5 px-3 py-1.5 text-[11px] text-warn">
      <span>Connection closed for this tab.</span>
      {connected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <span>Switch to:</span>
          {connected.map((c) => (
            <button
              key={c.connection_id}
              className="rounded border border-warn/40 px-1.5 py-0.5 hover:bg-warn/10"
              onClick={() => {
                if (!setConnection(tabId, c.connection_id)) {
                  toast.error("Can't switch this tab's connection", {
                    description: "Finish the running query, open transaction, or pending results first.",
                  });
                }
              }}
            >
              {c.database}
            </button>
          ))}
        </div>
      ) : (
        <span className="text-fg-muted">Connect to a database from the toolbar, then switch this tab to it.</span>
      )}
    </div>
  );
}
