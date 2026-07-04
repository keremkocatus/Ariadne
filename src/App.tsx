import { useCallback, useEffect } from "react";
import { SqlEditor } from "@/components/editor/SqlEditor";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { TabBar } from "@/components/query/TabBar";
import { ResultArea } from "@/components/query/ResultArea";
import { ConfirmDialog } from "@/components/query/ConfirmDialog";
import { CloseTabDialog } from "@/components/query/CloseTabDialog";
import { ConnectionClosedBanner } from "@/components/query/ConnectionClosedBanner";
import { EmptyStateCard } from "@/components/query/EmptyStateCard";
import { SaveTabDialog } from "@/components/query/SaveTabDialog";
import { Toolbar } from "@/components/layout/Toolbar";
import { StatusBar } from "@/components/layout/StatusBar";
import { ResizeHandle, HResizeHandle } from "@/components/layout/ResizeHandle";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { SettingsDialog } from "@/components/layout/SettingsDialog";
import { saveSqlFile } from "@/lib/fileActions";
import { toast } from "sonner";
import { offerReconnect } from "@/lib/sessionResume";
import { registerEventBridge } from "@/lib/events";
import { getRunSelection } from "@/lib/editorRun";
import { useGlobalShortcuts } from "@/lib/shortcuts";
import { useConnectionStore } from "@/stores/connectionStore";
import { useUiStore } from "@/stores/uiStore";
import { useTabsStore } from "@/stores/tabsStore";
import { getFunctionSource, isAriadneError, type ObjectInfo, type SnapFn } from "@/lib/api";

export default function App() {
  const connections = useConnectionStore((s) => s.connections);
  const { sidebarVisible, sidebarWidth, setSidebarWidth, resultsVisible, setResultsVisible, resultsHeight, setResultsHeight } =
    useUiStore();
  const editorFontSize = useUiStore((s) => s.settings.editorFontSize);
  const theme = useUiStore((s) => s.settings.theme);

  // Apply the color theme to the document root; the light overrides in index.css key off
  // data-theme. Runs on mount and whenever the setting changes.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const active = useTabsStore((s) => s.active());
  const closeRequest = useTabsStore((s) => s.closeRequest);
  const dirtyCloseRequest = useTabsStore((s) => s.dirtyCloseRequest);
  const dirtyTab = useTabsStore((s) => s.tabs.find((t) => t.id === s.dirtyCloseRequest) ?? null);
  const { addTab, setSql, run, fetchMore, dismissConfirmation, resolveClose, renameTab, setInfoResult } =
    useTabsStore();
  // Explorer follows the active *tab's* connection, not the global active connection
  // — switching tabs also switches the schema shown.
  const tabConnectionId = active?.connectionId ?? null;
  const tabConnectionInfo = tabConnectionId ? (connections[tabConnectionId] ?? null) : null;
  const tabConnectionClosed = !!tabConnectionId && !tabConnectionInfo;

  // Alt+F1 object info flows into the results area; open the panel if it's hidden.
  const showObjectInfo = useCallback(
    (info: ObjectInfo | null) => {
      if (!active || !info) return;
      setInfoResult(active.id, info);
      if (!resultsVisible) setResultsVisible(true);
    },
    [active, resultsVisible, setInfoResult, setResultsVisible],
  );

  useEffect(() => {
    const p = registerEventBridge();
    return () => void p.then((un) => un());
  }, []);

  // Guarantee one tab at startup.
  useEffect(() => {
    if (useTabsStore.getState().tabs.length === 0) addTab();
  }, [addTab]);

  // Startup reconnect invite once profiles load. offerReconnect is once-guarded
  // internally; silent if there are no matching restored tabs.
  useEffect(() => {
    void useConnectionStore.getState().loadProfiles().then(offerReconnect);
  }, []);

  useGlobalShortcuts();

  const runActive = useCallback(() => {
    // If there's a selection, run only it; otherwise the full text.
    if (active) void run(active.id, getRunSelection() ?? undefined);
  }, [active, run]);

  const openRelation = useCallback(
    (schema: string, name: string) => {
      // The new tab binds to the connection the Explorer shows (the active tab's) —
      // the global active connection may differ. sourceTable is set → cell editing
      // can be enabled.
      const id = addTab(`SELECT * FROM "${schema}"."${name}" LIMIT 500;`, tabConnectionId, {
        schema,
        name,
      });
      void run(id);
    },
    [addTab, run, tabConnectionId],
  );

  // Double-click a function → open its source in a new editable tab.
  const openFunction = useCallback(
    async (fn: SnapFn) => {
      if (!tabConnectionId) return;
      try {
        const src = await getFunctionSource(tabConnectionId, fn.oid);
        const id = addTab(src, tabConnectionId);
        renameTab(id, fn.name);
      } catch (e) {
        toast.error("Couldn't open function source", {
          description: isAriadneError(e) ? e.message : String(e),
        });
      }
    },
    [addTab, renameTab, tabConnectionId],
  );

  const q = active?.query;
  // Marker: if a selection ran, shift the offset into the full text; when the SQL is
  // edited (markerStale) the marker is hidden but the error banner stays.
  const errorMarker =
    q?.error && q.error.position != null && !q.markerStale
      ? { offset: q.error.position - 1 + q.selectionOffset, message: q.error.message }
      : null;

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <Toolbar />

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {sidebarVisible && (
          <>
            <aside style={{ width: sidebarWidth }} className="shrink-0 border-r border-border">
              <Sidebar
                connectionId={tabConnectionId}
                profileId={tabConnectionInfo?.profile_id ?? null}
                onOpenRelation={openRelation}
                onOpenFunction={openFunction}
              />
            </aside>
            <ResizeHandle width={sidebarWidth} onResize={setSidebarWidth} />
          </>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          {active ? (
            <>
              <div className="relative flex min-h-0 flex-1 flex-col border-b border-border">
                {tabConnectionClosed && <ConnectionClosedBanner tabId={active.id} />}
                <div className="relative min-h-0 flex-1">
                  <SqlEditor
                    key={active.id}
                    value={active.sql}
                    connectionId={tabConnectionId}
                    onChange={(v) => setSql(active.id, v)}
                    onRun={runActive}
                    onPeek={showObjectInfo}
                    marker={errorMarker}
                    fontSize={editorFontSize}
                    theme={theme}
                  />
                  <EmptyStateCard />
                </div>
              </div>
              {resultsVisible && (
                <>
                  {/* Vertical resize handle between the editor and results. */}
                  <HResizeHandle height={resultsHeight} onResize={setResultsHeight} />
                  <div style={{ height: resultsHeight }} className="min-h-0 shrink-0 overflow-hidden bg-bg">
                    <ResultArea tabId={active.id} onFetchMore={() => fetchMore(active.id)} />
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="flex-1" />
          )}
        </main>
      </div>

      <StatusBar />

      {q?.needsConfirmation && active && (
        <ConfirmDialog
          conf={q.needsConfirmation}
          onConfirm={() => {
            // The confirmed run must use the SAME opts (a selection if it was one) — pendingRun.
            const opts = { ...(q.pendingRun ?? {}), confirmed: true };
            dismissConfirmation(active.id);
            void run(active.id, opts);
          }}
          onCancel={() => dismissConfirmation(active.id)}
        />
      )}

      {closeRequest && (
        <CloseTabDialog
          onCommit={() => void resolveClose("commit")}
          onRollback={() => void resolveClose("rollback")}
          onCancel={() => void resolveClose("cancel")}
        />
      )}

      {dirtyCloseRequest && dirtyTab && (
        <SaveTabDialog
          fileName={dirtyTab.title}
          onSave={() =>
            void saveSqlFile(dirtyCloseRequest).then((ok) => {
              if (ok) useTabsStore.getState().forceCloseTab(dirtyCloseRequest);
            })
          }
          onDiscard={() => useTabsStore.getState().forceCloseTab(dirtyCloseRequest)}
          onCancel={() => useTabsStore.getState().cancelDirtyClose()}
        />
      )}

      <CommandPalette />
      <SettingsDialog />
    </div>
  );
}
