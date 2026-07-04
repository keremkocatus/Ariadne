import { useEffect, useRef, useState } from "react";
import { PanelLeft, Play, Square, Zap, Check, Undo2, Settings, FolderOpen, Save, Activity } from "lucide-react";
import { ConnectionMenu } from "@/components/connection/ConnectionMenu";
import { useUiStore } from "@/stores/uiStore";
import { useTabsStore } from "@/stores/tabsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { getRunSelection } from "@/lib/editorRun";
import { openSqlFile, saveSqlFile } from "@/lib/fileActions";
import { openServerActivity } from "@/lib/activityQuery";

// If Cancel doesn't end the query within this window, "Force kill" appears.
const FORCE_KILL_ARM_MS = 5000;

/// The top toolbar: sidebar toggle, connection picker, Run/Cancel, and tx-control
/// buttons. Reads its state from the stores — no prop coupling to App.
export function Toolbar() {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const active = useTabsStore((s) => s.active());
  const { run, cancel, forceKill, txControl } = useTabsStore();
  const connections = useConnectionStore((s) => s.connections);
  const q = active?.query;
  // A connectionId isn't enough — that connection may have closed. Leaving Run
  // clickable on a closed connection causes a confusing delayed error; the banner
  // already explains why.
  const canRun = !!active?.connectionId && !!connections[active.connectionId];

  // Force kill: for a query still running 5s after Cancel. `armed` = the queryId for
  // which force-kill is shown. Reset when the query ends.
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!q?.running) setArmed(null);
  }, [q?.running]);

  const runActive = () => {
    if (active) void run(active.id, getRunSelection() ?? undefined);
  };

  const onCancel = () => {
    if (!active) return;
    const qid = active.query.queryId;
    void cancel(active.id);
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => {
      const cur = useTabsStore.getState().tabs.find((t) => t.id === active.id);
      if (cur?.query.running && cur.query.queryId === qid) setArmed(qid ?? null);
    }, FORCE_KILL_ARM_MS);
  };

  return (
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
        className="rounded p-1 text-fg-muted hover:bg-bg-elev hover:text-fg"
        onClick={() => void openSqlFile()}
        title="Open .sql (Ctrl+O)"
      >
        <FolderOpen size={15} />
      </button>
      <button
        className="rounded p-1 text-fg-muted hover:bg-bg-elev hover:text-fg disabled:opacity-40"
        onClick={() => active && void saveSqlFile(active.id)}
        disabled={!active}
        title="Save (Ctrl+S)"
      >
        <Save size={15} />
      </button>
      <button
        className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-fg-muted hover:bg-bg-elev hover:text-fg disabled:opacity-40"
        onClick={() => openServerActivity(active?.connectionId ?? null)}
        disabled={!canRun}
        title="Server activity — open pg_stat_activity in a new query tab"
      >
        <Activity size={15} /> Activity
      </button>
      {q?.running ? (
        <div className="flex items-center gap-1.5">
          <button
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 rounded border border-danger/50 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10"
            title="Cancel (Esc)"
          >
            <Square size={11} /> Cancel
          </button>
          {armed === q.queryId && (
            <button
              onClick={() => active && void forceKill(active.id)}
              className="inline-flex items-center gap-1.5 rounded border border-danger bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/20"
              title="pg_terminate_backend — cancel didn't stop it"
            >
              <Zap size={11} /> Force kill
            </button>
          )}
        </div>
      ) : (
        <button
          onClick={runActive}
          disabled={!canRun}
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

      <button
        className="ml-auto rounded p-1 text-fg-muted hover:bg-bg-elev hover:text-fg"
        onClick={() => useUiStore.getState().setSettingsOpen(true)}
        title="Settings"
      >
        <Settings size={15} />
      </button>
      <span className="font-mono text-[11px] tracking-wide text-fg-muted">ariadne</span>
    </header>
  );
}
