import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeft, Play, Loader2 } from "lucide-react";
import { SqlEditor } from "@/components/editor/SqlEditor";
import { ResultView } from "@/components/query/ResultView";
import { Explorer } from "@/components/explorer/Explorer";
import { ConnectionMenu } from "@/components/connection/ConnectionMenu";
import { registerEventBridge } from "@/lib/events";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";
import { useUiStore } from "@/stores/uiStore";
import { isAriadneError, runQuery, type AriadneError, type RunResult } from "@/lib/api";

export default function App() {
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const activeInfo = useConnectionStore((s) => s.activeInfo());
  const cacheEntry = useSchemaStore((s) => (activeConnectionId ? s.byConnection[activeConnectionId] : undefined));
  const { sidebarVisible, sidebarWidth, toggleSidebar, setSidebarWidth } = useUiStore();

  const [sql, setSql] = useState("SELECT version();");
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<AriadneError | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const p = registerEventBridge();
    return () => void p.then((un) => un());
  }, []);

  const run = useCallback(async () => {
    if (running) return;
    if (!activeConnectionId) {
      setError({ kind: "connection_failed", message: "Connect to a database first" });
      return;
    }
    setRunning(true);
    setError(null);
    try {
      setResult(await runQuery(activeConnectionId, sql));
    } catch (e) {
      setResult(null);
      setError(isAriadneError(e) ? e : { kind: "internal", message: String(e) });
    } finally {
      setRunning(false);
    }
  }, [running, activeConnectionId, sql]);

  const openRelation = useCallback(
    (schema: string, name: string) => {
      const next = `SELECT * FROM "${schema}"."${name}" LIMIT 500;`;
      setSql(next);
      if (activeConnectionId) {
        setRunning(true);
        setError(null);
        runQuery(activeConnectionId, next)
          .then((r) => setResult(r))
          .catch((e) => {
            setResult(null);
            setError(isAriadneError(e) ? e : { kind: "internal", message: String(e) });
          })
          .finally(() => setRunning(false));
      }
    },
    [activeConnectionId],
  );

  // Global kısayollar: Ctrl+B sidebar, F5 çalıştır (editör dışıysa Explorer yenilesin).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

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
        <button
          onClick={run}
          disabled={running || !activeConnectionId}
          className="inline-flex items-center gap-1.5 rounded border border-fg bg-fg px-2.5 py-1 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-40"
          title="Ctrl+Enter / Ctrl+E"
        >
          {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          Run
        </button>
        <div className="ml-auto font-mono text-[11px] tracking-wide text-fg-muted">ariadne — M1</div>
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
          <div className="min-h-0 flex-[3] border-b border-border">
            <SqlEditor value={sql} onChange={setSql} onRun={run} />
          </div>
          <div className="min-h-0 flex-[2] overflow-auto bg-bg-elev">
            <ResultView result={result} error={error} />
          </div>
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
    </div>
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
  return (
    <div
      onMouseDown={onDown}
      className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-border"
    />
  );
}

function relTime(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}
