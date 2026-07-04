import { PanelLeft, Play, Square, Check, Undo2 } from "lucide-react";
import { ConnectionMenu } from "@/components/connection/ConnectionMenu";
import { useUiStore } from "@/stores/uiStore";
import { useTabsStore } from "@/stores/tabsStore";
import { useConnectionStore } from "@/stores/connectionStore";

/// Üst araç çubuğu: sidebar toggle, bağlantı seçici, Run/Cancel, tx kontrol
/// butonları (design 07 §2). Durumu store'lardan okur — App'e prop bağı yoktur.
export function Toolbar() {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const active = useTabsStore((s) => s.active());
  const { run, cancel, txControl } = useTabsStore();
  const connections = useConnectionStore((s) => s.connections);
  const q = active?.query;
  // connectionId olması yetmez — o bağlantı kapanmış olabilir (design 12 §P1-M1),
  // Run'ı kapalı bağlantıyla tıklanabilir bırakmak kafa karıştırıcı bir gecikmeli
  // hataya yol açar; banner zaten nedeni açıklıyor.
  const canRun = !!active?.connectionId && !!connections[active.connectionId];

  const runActive = () => {
    if (active) void run(active.id);
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

      <div className="ml-auto font-mono text-[11px] tracking-wide text-fg-muted">ariadne</div>
    </header>
  );
}
