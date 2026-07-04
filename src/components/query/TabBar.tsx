import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabsStore, isDirty } from "@/stores/tabsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { RoBadge } from "@/components/connection/RoBadge";
import type { TxStatus } from "@/lib/api";

export function TabBar() {
  const { tabs, activeTabId, setActive, addTab, closeTab, renameTab } = useTabsStore();
  const connections = useConnectionStore((s) => s.connections);
  const profiles = useConnectionStore((s) => s.profiles);
  // Double-click to rename: the tab id being edited + the draft.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // On Escape-cancel, prevents the blur (fired as the input unmounts) from committing
  // anyway (otherwise Escape would save the change).
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
          // Connection color stripe + tooltip + text label ("Query 3 · raildb") —
          // which connection the tab uses is visible on the tab.
          const info = t.connectionId ? connections[t.connectionId] : null;
          const closed = !!t.connectionId && !info;
          const connProfile = info ? profiles.find((p) => p.id === info.profile_id) : null;
          const connLabel = info ? connProfile?.name ?? info.database : null;
          const readOnly = connProfile?.read_only ?? false;
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
              {t.query.finishedUnseen && (
                <span
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", t.query.error ? "bg-danger" : "bg-fg")}
                  title={t.query.error ? "Query finished with an error" : "Query finished"}
                />
              )}
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
                  {isDirty(t) && <span className="mr-1 text-warn" title="Unsaved changes">●</span>}
                  {t.title}
                  {connLabel && <span className="ml-1 text-fg-muted">· {connLabel}</span>}
                  {readOnly && <RoBadge className="ml-1" />}
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
        {/* "+" follows the classic browser pattern: right after the last tab, scrolls with the strip. */}
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
