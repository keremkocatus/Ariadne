import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { TxStatus } from "@/lib/api";

export function TabBar() {
  const { tabs, activeTabId, setActive, addTab, closeTab } = useTabsStore();
  const connections = useConnectionStore((s) => s.connections);
  return (
    <div className="flex h-8 shrink-0 items-center border-b border-border bg-bg">
      <div className="flex flex-1 overflow-x-auto">
        {tabs.map((t) => {
          // Bağlantı renk şeridi + tooltip (design 12 §P1-M1 item 1): tab hangi
          // sunucuya bağlı, kapalıysa da ayırt edilsin (prod/dev karışmasın).
          const info = t.connectionId ? connections[t.connectionId] : null;
          const closed = !!t.connectionId && !info;
          const title = info ? `${info.database} (${info.user})` : closed ? "Connection closed" : "No connection";
          return (
            <div
              key={t.id}
              onClick={() => setActive(t.id)}
              title={title}
              className={cn(
                "group flex h-8 cursor-pointer items-center gap-1.5 border-r border-l-2 border-border px-3 text-xs",
                t.id === activeTabId ? "bg-bg-elev" : "hover:bg-bg-elev/50",
              )}
              style={{ borderLeftColor: info?.color || (closed ? "var(--color-warn)" : "transparent") }}
            >
              {t.query.txStatus !== "idle" && <TxBadge status={t.query.txStatus} />}
              <span className="max-w-[140px] truncate">{t.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                className="text-fg-muted opacity-0 group-hover:opacity-100 hover:text-fg"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        onClick={() => addTab("")}
        className="px-2 text-fg-muted hover:text-fg"
        title="New tab (Ctrl+T)"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

export function TxBadge({ status }: { status: TxStatus }) {
  if (status === "idle") return null;
  const aborted = status === "aborted";
  return (
    <span
      className={cn(
        "rounded px-1 text-[9px] font-bold",
        aborted ? "bg-danger/20 text-danger" : "bg-warn/20 text-warn",
      )}
      title={aborted ? "Transaction aborted — rollback needed" : "Open transaction"}
    >
      {aborted ? "TX!" : "TX"}
    </span>
  );
}
