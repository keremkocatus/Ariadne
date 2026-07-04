import { useCallback, useEffect, useState } from "react";
import { SqlEditor } from "@/components/editor/SqlEditor";
import { ObjectInfoPanel } from "@/components/editor/ObjectInfoPanel";
import { Explorer } from "@/components/explorer/Explorer";
import { TabBar } from "@/components/query/TabBar";
import { ResultArea } from "@/components/query/ResultArea";
import { ConfirmDialog } from "@/components/query/ConfirmDialog";
import { CloseTabDialog } from "@/components/query/CloseTabDialog";
import { ConnectionClosedBanner } from "@/components/query/ConnectionClosedBanner";
import { Toolbar } from "@/components/layout/Toolbar";
import { StatusBar } from "@/components/layout/StatusBar";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { toast } from "sonner";
import { registerEventBridge } from "@/lib/events";
import { getRunSelection } from "@/lib/editorRun";
import { useGlobalShortcuts } from "@/lib/shortcuts";
import { useConnectionStore } from "@/stores/connectionStore";
import { useUiStore } from "@/stores/uiStore";
import { useTabsStore } from "@/stores/tabsStore";
import { getFunctionSource, isAriadneError, type ObjectInfo, type SnapFn } from "@/lib/api";

export default function App() {
  const connections = useConnectionStore((s) => s.connections);
  const { sidebarVisible, sidebarWidth, setSidebarWidth, resultsVisible } = useUiStore();

  const active = useTabsStore((s) => s.active());
  const closeRequest = useTabsStore((s) => s.closeRequest);
  const { addTab, setSql, run, fetchMore, dismissConfirmation, resolveClose, renameTab } = useTabsStore();
  // Explorer aktif *tab'ın* bağlantısını gösterir, global aktif bağlantıyı değil
  // (design 12 §P1-M1) — tab değişince şema de değişir.
  const tabConnectionId = active?.connectionId ?? null;
  const tabConnectionInfo = tabConnectionId ? (connections[tabConnectionId] ?? null) : null;
  const tabConnectionClosed = !!tabConnectionId && !tabConnectionInfo;

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
    // Seçim varsa yalnız onu koştur (design 15 §P1-U2); yoksa tam metin.
    if (active) void run(active.id, getRunSelection() ?? undefined);
  }, [active, run]);

  const openRelation = useCallback(
    (schema: string, name: string) => {
      // Yeni tab, Explorer'ın gösterdiği (aktif tab'ın) bağlantısına bağlanır —
      // global aktif bağlantı farklı olabilir (design 12 §P1-M1).
      const id = addTab(`SELECT * FROM "${schema}"."${name}" LIMIT 500;`, tabConnectionId);
      void run(id);
    },
    [addTab, run, tabConnectionId],
  );

  // Fonksiyona çift tık → kaynağını yeni düzenlenebilir tab'da aç (design 15 §P1-U3).
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
  // Marker: seçim koşulduysa offset tam metne kaydırılır; SQL düzenlenince
  // (markerStale) marker gizlenir ama hata bandı kalır (design 15 §P1-U2).
  const errorMarker =
    q?.error && q.error.position != null && !q.markerStale
      ? { offset: q.error.position - 1 + q.selectionOffset, message: q.error.message }
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
              <div className="relative flex min-h-0 flex-[3] flex-col border-b border-border">
                {tabConnectionClosed && <ConnectionClosedBanner tabId={active.id} />}
                <div className="relative min-h-0 flex-1">
                  <SqlEditor
                    key={active.id}
                    value={active.sql}
                    connectionId={tabConnectionId}
                    onChange={(v) => setSql(active.id, v)}
                    onRun={runActive}
                    onPeek={setPeek}
                    marker={errorMarker}
                  />
                  {peek && <ObjectInfoPanel info={peek} onClose={() => setPeek(null)} />}
                </div>
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
            // Onaylanan run AYNI opts ile koşulmalı (seçimse seçim) — pendingRun.
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

      <CommandPalette />
    </div>
  );
}
