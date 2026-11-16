import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Activity,
  Check,
  ChevronDown,
  Clock,
  FolderOpen,
  ListTree,
  PanelBottom,
  PanelLeft,
  Play,
  Save,
  Settings,
  Square,
  Undo2,
  Zap,
  Bookmark,
} from "lucide-react";
import { ConnectionMenu } from "@/components/connection/ConnectionMenu";
import { Logo } from "@/components/brand/Logo";
import { IconButton } from "@/components/ui/primitives";
import { useUiStore } from "@/stores/uiStore";
import { useTabsStore } from "@/stores/tabsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { explainActive, runActive } from "@/lib/queryActions";
import { openSqlFile, saveSqlFile } from "@/lib/fileActions";
import { openServerActivity } from "@/lib/activityQuery";
import { cn } from "@/lib/utils";

// If Cancel doesn't end the query within this window, "Force kill" appears.
const FORCE_KILL_ARM_MS = 5000;

const MENU_ITEM =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 outline-none data-[highlighted]:bg-bg-hover";

/// The top toolbar: brand mark, connection picker, file and server tools, Run/Explain
/// and tx-control buttons. Reads its state from the stores — no prop coupling to App.
export function Toolbar() {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleResults = useUiStore((s) => s.toggleResults);
  const sidebarVisible = useUiStore((s) => s.sidebarVisible);
  const resultsVisible = useUiStore((s) => s.resultsVisible);
  const active = useTabsStore((s) => s.active());
  const { cancel, forceKill, txControl } = useTabsStore();
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
    <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center text-fg" title="Ariadne">
        <Logo size={19} />
      </span>
      <IconButton onClick={toggleSidebar} title="Sidebar (Ctrl+B)" active={sidebarVisible}>
        <PanelLeft size={15} />
      </IconButton>
      <ConnectionMenu />

      <Divider />
      <IconButton onClick={() => void openSqlFile()} title="Open .sql (Ctrl+O)">
        <FolderOpen size={15} />
      </IconButton>
      <IconButton onClick={() => active && void saveSqlFile(active.id)} disabled={!active} title="Save (Ctrl+S)">
        <Save size={15} />
      </IconButton>

      <Divider />
      <IconButton
        onClick={() => openServerActivity(active?.connectionId ?? null)}
        disabled={!canRun}
        title="Server activity — open pg_stat_activity in a new query tab"
      >
        <Activity size={15} />
      </IconButton>
      <IconButton
        onClick={() => useUiStore.getState().setCronOpen(true)}
        disabled={!canRun}
        title="Scheduled jobs (pg_cron)"
      >
        <Clock size={15} />
      </IconButton>
      <IconButton
        onClick={() => useUiStore.getState().setSnippetsOpen(true)}
        title="Snippets — saved queries on Ctrl+1 … Ctrl+0"
      >
        <Bookmark size={15} />
      </IconButton>

      <Divider />
      {q?.running ? (
        <div className="flex items-center gap-1.5">
          <button
            onClick={onCancel}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-danger/50 px-2.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
            title="Cancel (Esc)"
          >
            <Square size={11} /> Cancel
          </button>
          {armed === q.queryId && (
            <button
              onClick={() => active && void forceKill(active.id)}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-danger bg-danger/10 px-2.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20"
              title="pg_terminate_backend — cancel didn't stop it"
            >
              <Zap size={11} /> Force kill
            </button>
          )}
        </div>
      ) : (
        <>
          <button
            onClick={runActive}
            disabled={!canRun}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-fg bg-fg px-3 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
            title="Run the selection, or the whole tab (Ctrl+Enter / Ctrl+E / F5)"
          >
            <Play size={12} className="fill-current" /> Run
          </button>
          {/* Explain: one click for the estimated plan; the chevron holds ANALYZE. */}
          <div
            className={cn(
              "flex h-7 items-stretch overflow-hidden rounded-md border border-border",
              !canRun && "pointer-events-none opacity-40",
            )}
          >
            <button
              onClick={() => explainActive(false)}
              className="inline-flex items-center gap-1.5 px-2.5 text-xs transition-colors hover:bg-bg-hover"
              title="Execution plan of the selected statement — not executed (Ctrl+L)"
            >
              <ListTree size={13} /> Explain
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  className="flex items-center border-l border-border px-1 text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg"
                  title="More plan options"
                >
                  <ChevronDown size={12} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={4}
                  className="ari-menu-in z-50 w-72 rounded-lg border border-border bg-bg-elev p-1 text-xs shadow-2xl"
                >
                  <DropdownMenu.Item className={MENU_ITEM} onSelect={() => explainActive(false)}>
                    <span className="flex-1">
                      Explain
                      <span className="block text-[10px] text-fg-muted">Estimated plan — nothing runs</span>
                    </span>
                    <span className="text-[10px] text-fg-subtle">Ctrl+L</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className={MENU_ITEM} onSelect={() => explainActive(true)}>
                    <span className="flex-1">
                      Explain Analyze
                      <span className="block text-[10px] text-fg-muted">
                        Runs the statement for real timings, then rolls back
                      </span>
                    </span>
                    <span className="text-[10px] text-fg-subtle">Ctrl+Shift+L</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </>
      )}

      {q && q.txStatus !== "idle" && active && (
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => txControl(active.id, "COMMIT")}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs transition-colors hover:bg-bg-hover"
          >
            <Check size={11} /> Commit
          </button>
          <button
            onClick={() => txControl(active.id, "ROLLBACK")}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-warn/50 px-2 text-xs text-warn transition-colors hover:bg-warn/10"
          >
            <Undo2 size={11} /> Rollback
          </button>
          {q.txStatus === "aborted" && (
            <span className="text-[11px] text-danger">Transaction aborted — rollback first</span>
          )}
        </div>
      )}

      <div className="ml-auto flex items-center gap-1">
        <IconButton onClick={toggleResults} title="Results panel (Ctrl+R)" active={resultsVisible}>
          <PanelBottom size={15} />
        </IconButton>
        <IconButton onClick={() => useUiStore.getState().setSettingsOpen(true)} title="Settings">
          <Settings size={15} />
        </IconButton>
      </div>
    </header>
  );
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px shrink-0 bg-border" />;
}
