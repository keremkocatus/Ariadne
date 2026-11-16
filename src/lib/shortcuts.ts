import { useEffect } from "react";
import { useUiStore } from "@/stores/uiStore";
import { useTabsStore } from "@/stores/tabsStore";
import { openSqlFile, saveSqlFile } from "@/lib/fileActions";
import { explainActive, runSnippet } from "@/lib/queryActions";

/// Is the cursor inside the Monaco editor? Used to give the editor chord priority for
/// keys like Ctrl+K. True if activeElement is within the editor DOM.
function inEditor(): boolean {
  const el = document.activeElement;
  return !!el && !!el.closest?.(".monaco-editor");
}

/// Whether a modal dialog is open. Shortcuts that act on the editor behind it are
/// suppressed, so typing in a dialog can never run a query.
function modalOpen(): boolean {
  return !!document.querySelector('[role="dialog"]');
}

/// The snippet slot of a Ctrl+<digit> press, from the physical key so it works on
/// every keyboard layout. Slot 0 is Ctrl+1 … slot 9 is Ctrl+0.
function snippetSlot(e: KeyboardEvent): number | null {
  const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (!m) return null;
  return (Number(m[1]) + 9) % 10;
}

/// Global (outside-editor) shortcuts. In-editor shortcuts (Ctrl+Enter/E, Alt+F1,
/// Ctrl+D) are registered as Monaco commands in SqlEditor. The effect has no
/// dependencies because stores are accessed via `getState()`.
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const tabs = useTabsStore.getState();
      // AltGr arrives as Ctrl+Alt on Windows; on layouts that type characters with
      // AltGr+<digit> it must not fire a Ctrl shortcut.
      const ctrl = e.ctrlKey && !e.altKey;
      const slot = ctrl && !e.shiftKey ? snippetSlot(e) : null;

      if (slot != null) {
        if (modalOpen()) return;
        // Also keeps the webview from treating Ctrl+0 as "reset zoom".
        e.preventDefault();
        runSnippet(slot);
      } else if (ctrl && k === "l") {
        // Inside the editor Monaco's own binding handles it (see SqlEditor).
        if (inEditor() || modalOpen()) return;
        e.preventDefault();
        explainActive(e.shiftKey);
      } else if (e.ctrlKey && k === "b") {
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
