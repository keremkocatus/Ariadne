import { useEffect } from "react";
import { useUiStore } from "@/stores/uiStore";
import { useTabsStore } from "@/stores/tabsStore";
import { openSqlFile, saveSqlFile } from "@/lib/fileActions";

/// Is the cursor inside the Monaco editor? Used to give the editor chord priority for
/// keys like Ctrl+K. True if activeElement is within the editor DOM.
function inEditor(): boolean {
  const el = document.activeElement;
  return !!el && !!el.closest?.(".monaco-editor");
}

/// Global (outside-editor) shortcuts. In-editor shortcuts (Ctrl+Enter/E, Alt+F1,
/// Ctrl+D) are registered as Monaco commands in SqlEditor. The effect has no
/// dependencies because stores are accessed via `getState()`.
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const tabs = useTabsStore.getState();

      if (e.ctrlKey && k === "b") {
        e.preventDefault();
        useUiStore.getState().toggleSidebar();
      } else if (e.ctrlKey && k === "r") {
        // Show/hide the results panel (SSMS).
        e.preventDefault();
        useUiStore.getState().toggleResults();
      } else if (e.ctrlKey && (k === "t" || k === "n")) {
        // Ctrl+T / Ctrl+N: new query tab bound to the active tab's connection.
        // Ctrl+N is the SSMS "New Query" equivalent.
        e.preventDefault();
        const connId = tabs.tabs.find((t) => t.id === tabs.activeTabId)?.connectionId ?? null;
        tabs.addTab("", connId);
      } else if (e.ctrlKey && k === "w") {
        e.preventDefault();
        if (tabs.activeTabId) tabs.closeTab(tabs.activeTabId);
      } else if (e.ctrlKey && k === "o") {
        // Open a .sql file.
        e.preventDefault();
        void openSqlFile();
      } else if (e.ctrlKey && k === "s") {
        // Ctrl+S saves, Ctrl+Shift+S is save-as.
        e.preventDefault();
        if (tabs.activeTabId) void saveSqlFile(tabs.activeTabId, e.shiftKey);
      } else if (e.ctrlKey && k === "k") {
        // Command palette — but when the editor is focused, Monaco's chord wins.
        if (inEditor()) return;
        e.preventDefault();
        useUiStore.getState().setPaletteOpen(true);
      } else if (k === "escape") {
        // Cancel while a query runs; otherwise leave it to Monaco/others.
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
