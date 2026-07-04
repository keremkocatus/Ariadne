import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { TxStatus } from "@/lib/api";

export function TabBar() {
  const { tabs, activeTabId, setActive, addTab, closeTab, renameTab } = useTabsStore();
  const connections = useConnectionStore((s) => s.connections);
  const profiles = useConnectionStore((s) => s.profiles);
  // Çift-tık ile yeniden adlandırma (design 15 §P1-U2): düzenlenen tab id + taslak.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape ile iptalde, input unmount olurken tetiklenen blur'ün yine de commit
  // etmesini engeller (aksi halde Escape değişikliği kaydederdi).
  const cancelRef = useRef(false);

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  const startRename = (id: string, title: string) => {
    cancelRef.current = false;
    setDraft(title);
    setEditingId(id);
  };
  const commitRename = () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    if (editingId) renameTab(editingId, draft);
    setEditingId(null);
  };
  const cancelRename = () => {
    cancelRef.current = true;
    setEditingId(null);
  };

  return (
    <div className="flex h-8 shrink-0 items-center border-b border-border bg-bg">
      <div className="flex flex-1 items-center overflow-x-auto">
        {tabs.map((t) => {
          // Bağlantı renk şeridi + tooltip (design 12 §P1-M1) + metin etiketi
          // (design 15 §P1-U2): "Query 3 · raildb" — hangi bağlantı olduğu tab'da görünür.
          const info = t.connectionId ? connections[t.connectionId] : null;
          const closed = !!t.connectionId && !info;
          const connLabel = info
            ? profiles.find((p) => p.id === info.profile_id)?.name ?? info.database
            : null;
          const title = info ? `${info.database} (${info.user})` : closed ? "Connection closed" : "No connection";
          return (
            <div
              key={t.id}
              onClick={() => setActive(t.id)}
              title={title}
              className={cn(
                "group flex h-8 shrink-0 cursor-pointer items-center gap-1.5 border-r border-l-2 border-border px-3 text-xs",
                t.id === activeTabId ? "bg-bg-elev" : "hover:bg-bg-elev/50",
              )}
              style={{ borderLeftColor: info?.color || (closed ? "var(--color-warn)" : "transparent") }}
            >
              {t.query.txStatus !== "idle" && <TxBadge status={t.query.txStatus} />}
              {editingId === t.id ? (
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") cancelRename();
                  }}
                  className="w-24 rounded border border-fg-muted bg-bg px-1 text-xs outline-none"
                />
              ) : (
                <span
                  className="max-w-[180px] truncate"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startRename(t.id, t.title);
                  }}
                >
                  {t.title}
                  {connLabel && <span className="ml-1 text-fg-muted">· {connLabel}</span>}
                </span>
              )}
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
        {/* "+" klasik tarayıcı deseni: son tab'ın hemen sağında, şeritle akar. */}
        <button
          onClick={() => addTab("")}
          className="shrink-0 px-2 text-fg-muted hover:text-fg"
          title="New tab (Ctrl+T)"
        >
          <Plus size={14} />
        </button>
      </div>
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
