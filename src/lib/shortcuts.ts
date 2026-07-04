import { useEffect } from "react";
import { useUiStore } from "@/stores/uiStore";
import { useTabsStore } from "@/stores/tabsStore";
import { openSqlFile, saveSqlFile } from "@/lib/fileActions";

/// İmleç Monaco editörünün içinde mi? Ctrl+K gibi tuşlarda editör chord'una
/// öncelik vermek için (design 07 §3). activeElement editör DOM'unun içindeyse true.
function inEditor(): boolean {
  const el = document.activeElement;
  return !!el && !!el.closest?.(".monaco-editor");
}

/// Global (editör dışı) kısayollar (design 07 §3). Editör-içi kısayollar
/// (Ctrl+Enter/E, Alt+F1, Ctrl+D) SqlEditor'da Monaco komutu olarak kayıtlı.
/// Store'lara `getState()` ile erişildiği için effect'in bağımlılığı yoktur.
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const tabs = useTabsStore.getState();

      if (e.ctrlKey && k === "b") {
        e.preventDefault();
        useUiStore.getState().toggleSidebar();
      } else if (e.ctrlKey && k === "r") {
        // Sonuç panelini gizle/göster (SSMS).
        e.preventDefault();
        useUiStore.getState().toggleResults();
      } else if (e.ctrlKey && (k === "t" || k === "n")) {
        // Ctrl+T / Ctrl+N: yeni query tab'ı, aktif tab'ın bağlantısına bağlı
        // (design 18 §P1-W3 N7). Ctrl+N SSMS "New Query" muadili.
        e.preventDefault();
        const connId = tabs.tabs.find((t) => t.id === tabs.activeTabId)?.connectionId ?? null;
        tabs.addTab("", connId);
      } else if (e.ctrlKey && k === "w") {
        e.preventDefault();
        if (tabs.activeTabId) tabs.closeTab(tabs.activeTabId);
      } else if (e.ctrlKey && k === "o") {
        // .sql aç (design 15 §P1-U4).
        e.preventDefault();
        void openSqlFile();
      } else if (e.ctrlKey && k === "s") {
        // Ctrl+S kaydet, Ctrl+Shift+S farklı kaydet.
        e.preventDefault();
        if (tabs.activeTabId) void saveSqlFile(tabs.activeTabId, e.shiftKey);
      } else if (e.ctrlKey && k === "k") {
        // Command palette — ama editör odaklıyken Monaco chord'u (Ctrl+K Ctrl+C) öncelikli.
        if (inEditor()) return;
        e.preventDefault();
        useUiStore.getState().setPaletteOpen(true);
      } else if (k === "escape") {
        // Sorgu koşarken iptal; aksi halde Monaco/diğerlerine bırak.
        const active = tabs.tabs.find((t) => t.id === tabs.activeTabId);
        if (active?.query.running) {
          e.preventDefault();
          void tabs.cancel(active.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
