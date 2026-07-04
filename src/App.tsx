import { useCallback, useEffect, useState } from "react";
import { SqlEditor } from "@/components/editor/SqlEditor";
import { ObjectInfoPanel } from "@/components/editor/ObjectInfoPanel";
import { Explorer } from "@/components/explorer/Explorer";
import { TabBar } from "@/components/query/TabBar";
import { ResultArea } from "@/components/query/ResultArea";
import { ConfirmDialog } from "@/components/query/ConfirmDialog";
import { CloseTabDialog } from "@/components/query/CloseTabDialog";
import { Toolbar } from "@/components/layout/Toolbar";
import { StatusBar } from "@/components/layout/StatusBar";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { registerEventBridge } from "@/lib/events";
import { useGlobalShortcuts } from "@/lib/shortcuts";
import { useConnectionStore } from "@/stores/connectionStore";
import { useUiStore } from "@/stores/uiStore";
import { useTabsStore } from "@/stores/tabsStore";
import type { ObjectInfo } from "@/lib/api";

export default function App() {
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const activeInfo = useConnectionStore((s) => s.activeInfo());
  const { sidebarVisible, sidebarWidth, setSidebarWidth, resultsVisible } = useUiStore();

  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const closeRequest = useTabsStore((s) => s.closeRequest);
  const { addTab, setSql, run, fetchMore, dismissConfirmation, resolveClose } = useTabsStore();
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

  useGlobalShortcuts();

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

  const q = active?.query;
  const errorMarker =
    q?.error && q.error.position != null
      ? { offset: q.error.position - 1, message: q.error.message }
      : null;

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <Toolbar />

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
              {resultsVisible && (
                <div className="min-h-0 flex-[2] overflow-hidden bg-bg">
                  <ResultArea tabId={active.id} onFetchMore={() => fetchMore(active.id)} />
                </div>
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
            dismissConfirmation(active.id);
            void run(active.id, true);
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

      <CommandPalette />
    </div>
  );
}
