import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabsStore, isDirty } from "@/stores/tabsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { RoBadge } from "@/components/connection/RoBadge";
import { QuickActionMenu } from "@/components/explorer/QuickActionMenu";
import type { TxStatus } from "@/lib/api";

export function TabBar() {
  const { tabs, activeTabId, setActive, addTab, closeTab, renameTab } = useTabsStore();
  const connections = useConnectionStore((s) => s.connections);
  const profiles = useConnectionStore((s) => s.profiles);
  // Double-click to rename: the tab id being edited + the draft.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  // On Escape-cancel, prevents the blur (fired as the input unmounts) from committing
  // anyway (otherwise Escape would save the change).
  const cancelRef = useRef(false);

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  // Keep the active tab in view when it changes (new tab, keyboard close, palette).
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

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

  // Closing several tabs goes through closeTab one at a time, so a tab with an open
  // transaction or unsaved file still raises its confirmation instead of vanishing.
  const closeMany = (ids: string[]) => ids.forEach((id) => closeTab(id));

  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border bg-bg">
      <div
        ref={stripRef}
        className="flex flex-1 items-center gap-0.5 overflow-x-auto px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        // A wheel over the strip scrolls it sideways — tabs have no vertical extent.
        onWheel={(e) => {
          if (e.deltaY !== 0) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((t) => {
          // Connection color dot + tooltip + text label ("Query 3 · raildb") —
          // which connection the tab uses is visible on the tab.
          const info = t.connectionId ? connections[t.connectionId] : null;
          const closed = !!t.connectionId && !info;
          const connProfile = info ? profiles.find((p) => p.id === info.profile_id) : null;
          const connLabel = info ? connProfile?.name ?? info.database : null;
          const readOnly = connProfile?.read_only ?? false;
          const title = info ? `${info.database} (${info.user})` : closed ? "Connection closed" : "No connection";
          const active = t.id === activeTabId;
          const dotColor = info?.color || (closed ? "var(--color-warn)" : null);
          return (
            <div
              key={t.id}
              data-active={active}
              onClick={() => setActive(t.id)}
              // Middle click closes, as in a browser. The mousedown is swallowed too so
              // the webview doesn't enter its autoscroll mode.
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(t.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ id: t.id, x: e.clientX, y: e.clientY });
              }}
              title={title}
              className={cn(
                "group relative flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border pl-2.5 pr-1.5 text-xs transition-colors",
                active
                  ? "border-border bg-bg-elev text-fg shadow-sm"
                  : "border-transparent text-fg-muted hover:bg-bg-hover hover:text-fg",
              )}
            >
              {dotColor && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dotColor }} />
              )}
              {t.query.txStatus !== "idle" && <TxBadge status={t.query.txStatus} />}
              {t.query.finishedUnseen && (
                <span
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", t.query.error ? "bg-danger" : "bg-fg")}
                  title={t.query.error ? "Query finished with an error" : "Query finished"}
                />
              )}
              {t.query.running && (
                <span
                  className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-fg-muted border-t-transparent"
                  title="Running"
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
                  className="max-w-[200px] truncate"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startRename(t.id, t.title);
                  }}
                >
                  {isDirty(t) && <span className="mr-1 text-warn" title="Unsaved changes">●</span>}
                  {t.title}
                  {connLabel && <span className="ml-1 text-fg-subtle">· {connLabel}</span>}
                  {readOnly && <RoBadge className="ml-1" />}
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                title="Close (Ctrl+W / middle-click)"
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-muted transition-colors hover:bg-fg/10 hover:text-fg",
                  !active && "opacity-0 group-hover:opacity-100",
                )}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
        {/* "+" follows the classic browser pattern: right after the last tab, scrolls with the strip. */}
        <button
          onClick={() => addTab("")}
          className="ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
          title="New tab (Ctrl+T)"
        >
          <Plus size={14} />
        </button>
      </div>

      {menu && (
        <QuickActionMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          actions={[
            {
              label: "Rename",
              onClick: () => {
                const tab = tabs.find((t) => t.id === menu.id);
                if (tab) startRename(tab.id, tab.title);
              },
            },
            {
              label: "Duplicate",
              onClick: () => {
                const tab = tabs.find((t) => t.id === menu.id);
                if (tab) addTab(tab.sql, tab.connectionId);
              },
            },
            "separator",
            { label: "Close", hint: "Ctrl+W", onClick: () => closeTab(menu.id) },
            {
              label: "Close others",
              disabled: tabs.length < 2,
              onClick: () => closeMany(tabs.filter((t) => t.id !== menu.id).map((t) => t.id)),
            },
            {
              label: "Close to the right",
              disabled: tabs.findIndex((t) => t.id === menu.id) === tabs.length - 1,
              onClick: () => {
                const i = tabs.findIndex((t) => t.id === menu.id);
                closeMany(tabs.slice(i + 1).map((t) => t.id));
              },
            },
          ]}
        />
      )}
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
