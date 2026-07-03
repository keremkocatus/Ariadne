import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeft, Play, Square, Check, Undo2 } from "lucide-react";
import { SqlEditor } from "@/components/editor/SqlEditor";
import { ObjectInfoPanel } from "@/components/editor/ObjectInfoPanel";
import { ResultGrid } from "@/components/grid/ResultGrid";
import { Explorer } from "@/components/explorer/Explorer";
import { ConnectionMenu } from "@/components/connection/ConnectionMenu";
import { TabBar } from "@/components/query/TabBar";
import { ConfirmDialog } from "@/components/query/ConfirmDialog";
import { registerEventBridge } from "@/lib/events";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";
import { useUiStore } from "@/stores/uiStore";
import { useTabsStore } from "@/stores/tabsStore";
import type { ObjectInfo } from "@/lib/api";

export default function App() {
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const activeInfo = useConnectionStore((s) => s.activeInfo());
  const cacheEntry = useSchemaStore((s) =>
    activeConnectionId ? s.byConnection[activeConnectionId] : undefined,
  );
  const { sidebarVisible, sidebarWidth, toggleSidebar, setSidebarWidth } = useUiStore();

  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const { addTab, closeTab, setSql, run, fetchMore, cancel, txControl, dismissConfirmation } =
    useTabsStore();
  const active = tabs.find((t) => t.id === activeTabId) ?? null;

  const [peek, setPeek] = useState<ObjectInfo | null>(null);

  useEffect(() => {
    const p = registerEventBridge();
    return () => void p.then((un) => un());
  }, []);

  // Açılışta bir tab garanti et.
  useEffect(() => {
    if (useTabsStore.getState().tabs.length === 0) addTab();
  }, [addTab]);

  const runActive = useCallback(() => {
    if (active) void run(active.id);
  }, [active, run]);

  const openRelation = useCallback(
    (schema: string, name: string) => {
      const id = addTab(`SELECT * FROM "${schema}"."${name}" LIMIT 500;`);
      void run(id);
    },
    [addTab, run],
  );

  // Global kısayollar (design 07 §3).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.ctrlKey && k === "t") {
        e.preventDefault();
        addTab("");
      } else if (e.ctrlKey && k === "w") {
        e.preventDefault();
        if (activeTabId) closeTab(activeTabId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar, addTab, closeTab, activeTabId]);

  const q = active?.query;
  const errorMarker =
    q?.error && q.error.position != null
      ? { offset: q.error.position - 1, message: q.error.message }
      : null;

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      {/* Toolbar */}
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <button
          className="rounded p-1 text-fg-muted hover:bg-bg-elev hover:text-fg"
          onClick={toggleSidebar}
          title="Sidebar (Ctrl+B)"
        >
          <PanelLeft size={15} />
        </button>
        <ConnectionMenu />
        {q?.running ? (
          <button
            onClick={() => active && cancel(active.id)}
            className="inline-flex items-center gap-1.5 rounded border border-danger/50 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10"
            title="Cancel (Esc)"
          >
            <Square size={11} /> Cancel
          </button>
        ) : (
          <button
            onClick={runActive}
            disabled={!activeConnectionId}
            className="inline-flex items-center gap-1.5 rounded border border-fg bg-fg px-2.5 py-1 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-40"
            title="Ctrl+Enter / Ctrl+E / F5"
          >
            <Play size={12} /> Run
          </button>
        )}

        {q && q.txStatus !== "idle" && active && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => txControl(active.id, "COMMIT")}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:border-fg-muted"
            >
              <Check size={11} /> Commit
            </button>
            <button
              onClick={() => txControl(active.id, "ROLLBACK")}
              className="inline-flex items-center gap-1 rounded border border-warn/50 px-2 py-1 text-xs text-warn hover:bg-warn/10"
            >
              <Undo2 size={11} /> Rollback
            </button>
            {q.txStatus === "aborted" && (
              <span className="text-[11px] text-danger">Transaction aborted — rollback first</span>
            )}
          </div>
        )}

        <div className="ml-auto font-mono text-[11px] tracking-wide text-fg-muted">ariadne</div>
      </header>

      {/* Gövde */}
      <div className="flex min-h-0 flex-1">
        {sidebarVisible && (
          <>
            <aside style={{ width: sidebarWidth }} className="shrink-0 border-r border-border">
              <Explorer
                connectionId={activeConnectionId}
                profileId={activeInfo?.profile_id ?? null}
                onOpenRelation={openRelation}
              />
            </aside>
            <ResizeHandle width={sidebarWidth} onResize={setSidebarWidth} />
          </>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          {active ? (
            <>
              <div className="relative min-h-0 flex-[3] border-b border-border">
                <SqlEditor
                  key={active.id}
                  value={active.sql}
                  onChange={(v) => setSql(active.id, v)}
                  onRun={runActive}
                  onPeek={setPeek}
                  marker={errorMarker}
                />
                {peek && <ObjectInfoPanel info={peek} onClose={() => setPeek(null)} />}
              </div>
              <div className="min-h-0 flex-[2] overflow-hidden bg-bg">
                <ResultArea tabId={active.id} onFetchMore={() => fetchMore(active.id)} />
              </div>
            </>
          ) : (
            <div className="flex-1" />
          )}
        </main>
      </div>

      {/* Status bar */}
      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-2 text-[11px] text-fg-muted">
        {activeInfo ? (
          <>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: activeInfo.color || "#4ade80" }} />
              {activeInfo.database} · PostgreSQL {activeInfo.server_version.split(" ")[0]}
            </span>
            <span>cache: {cacheEntry?.snapshot ? relTime(cacheEntry.snapshot.fetched_at) : "—"}</span>
          </>
        ) : (
          <span>no connection</span>
        )}
        <span className="ml-auto">v0.0.0</span>
      </footer>

      {q?.needsConfirmation && active && (
        <ConfirmDialog
          conf={q.needsConfirmation}
          onConfirm={() => {
            dismissConfirmation(active.id);
            void run(active.id, true);
          }}
          onCancel={() => dismissConfirmation(active.id)}
        />
      )}
    </div>
  );
}

function ResultArea({ tabId, onFetchMore }: { tabId: string; onFetchMore: () => void }) {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === tabId));
  const q = tab?.query;
  if (!q) return null;

  if (q.error) {
    // İptal edilen sorgu hata gibi gösterilmez (design 05 §3).
    if (q.error.kind === "query_cancelled") {
      return <p className="p-3 font-mono text-xs text-fg-muted">Query cancelled.</p>;
    }
    return (
      <pre className="whitespace-pre-wrap p-3 font-mono text-xs text-danger">
        [{q.error.kind}
        {q.error.sqlstate ? ` ${q.error.sqlstate}` : ""}] {q.error.message}
        {q.error.hint ? `\nHINT: ${q.error.hint}` : ""}
      </pre>
    );
  }
  if (q.columns.length > 0) {
    return (
      <ResultGrid
        columns={q.columns}
        rows={q.rows}
        hasMore={q.hasMore}
        fetchingMore={q.fetchingMore}
        capped={q.capped}
        fetchedTotal={q.fetchedTotal}
        elapsedMs={q.elapsedMs}
        onFetchMore={onFetchMore}
      />
    );
  }
  if (q.extra.length > 0) {
    return (
      <div className="space-y-1 p-3 font-mono text-xs">
        {q.extra.map((s, i) => (
          <div key={i} className={s.kind === "empty" ? "text-fg-muted" : ""}>
            {s.kind === "affected"
              ? `${s.command} — ${s.row_count} row(s)`
              : s.kind === "empty"
                ? s.command
                : ""}
          </div>
        ))}
      </div>
    );
  }
  return (
    <p className="p-3 font-mono text-xs text-fg-muted">
      {q.running ? "Running…" : "Results will appear here. Run with Ctrl+Enter."}
    </p>
  );
}

function ResizeHandle({ width, onResize }: { width: number; onResize: (w: number) => void }) {
  const startX = useRef(0);
  const startW = useRef(0);
  const onDown = (e: React.MouseEvent) => {
    startX.current = e.clientX;
    startW.current = width;
    const onMove = (ev: MouseEvent) => onResize(startW.current + (ev.clientX - startX.current));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return <div onMouseDown={onDown} className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-border" />;
}

function relTime(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}
