// Session-only query history. Lists finished runs newest-first; click an entry to
// reopen its SQL in a new tab. Cleared on every app restart (the store isn't persisted).
import { useState } from "react";
import { Search, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHistoryStore, type HistoryEntry } from "@/stores/historyStore";
import { useTabsStore } from "@/stores/tabsStore";

export function QueryHistory({ connectionId }: { connectionId: string | null }) {
  const entries = useHistoryStore((s) => s.entries);
  const clear = useHistoryStore((s) => s.clear);
  const [search, setSearch] = useState("");

  const q = search.trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) => e.sql.toLowerCase().includes(q) || e.connectionLabel.toLowerCase().includes(q))
    : entries;

  const openInTab = (e: HistoryEntry) => {
    // Reopen on the active tab's connection; the run's original connection may be gone.
    useTabsStore.getState().addTab(e.sql, connectionId);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border p-1.5">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter history…"
            className="w-full rounded border border-border bg-bg py-1 pl-6 pr-2 text-xs outline-none focus:border-fg-muted"
          />
        </div>
        <button
          title="Clear history"
          onClick={clear}
          disabled={entries.length === 0}
          className="rounded border border-border p-1 text-fg-muted hover:text-fg disabled:opacity-40"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {entries.length === 0 ? (
        <Empty text="No queries run yet this session" />
      ) : filtered.length === 0 ? (
        <Empty text="No matches" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {filtered.map((e) => (
            <button
              key={e.id}
              onClick={() => openInTab(e)}
              title={e.errorMessage ?? "Open in a new tab"}
              className="flex w-full flex-col gap-0.5 px-2 py-1 text-left hover:bg-bg-elev"
            >
              <span className="flex items-center gap-1.5">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", e.status === "ok" ? "bg-fg" : "bg-danger")} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{firstLine(e.sql)}</span>
              </span>
              <span className="flex items-center gap-1.5 pl-3 text-[10px] text-fg-muted">
                <span>{relTime(e.at)}</span>
                <span>· {e.connectionLabel}</span>
                <span className="ml-auto tabular-nums">
                  {e.rowCount != null ? `${e.rowCount.toLocaleString()} rows · ` : ""}
                  {fmtDuration(e.elapsedMs)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="p-3 text-xs text-fg-muted">{text}</div>;
}

function firstLine(sql: string): string {
  const trimmed = sql.trim();
  const i = trimmed.indexOf("\n");
  return i === -1 ? trimmed : trimmed.slice(0, i);
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function relTime(at: number): string {
  const secs = Math.max(0, (Date.now() - at) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}
