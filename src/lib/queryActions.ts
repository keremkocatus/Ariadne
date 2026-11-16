// Run-path actions shared by the toolbar, keyboard shortcuts, the command palette and
// the editor's own key bindings, so every entry point behaves identically.
import { toast } from "sonner";
import { getRunSelection, placeSnippet } from "@/lib/editorRun";
import { useConnectionStore } from "@/stores/connectionStore";
import { useTabsStore } from "@/stores/tabsStore";
import { snippetKey, useUiStore } from "@/stores/uiStore";

/// Runs the active tab: the editor selection if there is one, otherwise the full text.
export function runActive(): void {
  const tabs = useTabsStore.getState();
  if (tabs.activeTabId) void tabs.run(tabs.activeTabId, getRunSelection() ?? undefined);
}

/// Shows the execution plan of the selected statement (or the whole text when nothing
/// is selected). `analyze` executes it for real timings and rolls the effects back.
export function explainActive(analyze: boolean): void {
  const tabs = useTabsStore.getState();
  if (!tabs.activeTabId) return;
  const sel = getRunSelection();
  void tabs.explain(tabs.activeTabId, {
    analyze,
    sql: sel?.sql,
    selectionOffset: sel?.selectionOffset,
  });
}

/// Ctrl+<digit>: puts the slot's saved query into the active editor (reusing a copy
/// that is already there) and runs just that query.
export function runSnippet(slot: number): void {
  const ui = useUiStore.getState();
  const snippet = ui.settings.snippets[slot];
  if (!snippet || !snippet.sql.trim()) {
    toast.message(`No snippet on Ctrl+${snippetKey(slot)}`, {
      action: { label: "Set up", onClick: () => ui.setSnippetsOpen(true) },
    });
    return;
  }
  const tabs = useTabsStore.getState();
  const tab = tabs.active();
  if (!tab) return;
  const tabId = tab.id;
  // Checked before touching the document: inserting text and then not running it
  // would leave the user with an edit they didn't ask for.
  if (tab.query.running) {
    toast.message("A query is still running in this tab");
    return;
  }
  if (!tab.connectionId || !useConnectionStore.getState().connections[tab.connectionId]) {
    toast.message("Connect to a database first");
    return;
  }
  const placed = placeSnippet(snippet.sql);
  if (!placed) return;
  void tabs.run(tabId, placed);
}
