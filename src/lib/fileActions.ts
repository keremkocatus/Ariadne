// Orchestration for opening/saving .sql files. The native dialog
// (@tauri-apps/plugin-dialog) + our own read/write commands. The Toolbar, shortcuts,
// and palette all go through this single source.
import { open, save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { isAriadneError, readTextFile, writeTextFile } from "@/lib/api";
import { useTabsStore } from "@/stores/tabsStore";
import { useConnectionStore } from "@/stores/connectionStore";

const SQL_FILTERS = [
  { name: "SQL", extensions: ["sql"] },
  { name: "All files", extensions: ["*"] },
];

function fail(what: string, e: unknown) {
  toast.error(what, { description: isAriadneError(e) ? e.message : String(e) });
}

/// Ctrl+O: pick a file → content into a new tab (title = file name, inherits the
/// active connection).
export async function openSqlFile() {
  try {
    const selected = await open({ multiple: false, filters: SQL_FILTERS });
    if (typeof selected !== "string") return; // cancelled
    const content = await readTextFile(selected);
    const connId = useConnectionStore.getState().activeConnectionId;
    useTabsStore.getState().openFileTab(content, selected, connId);
  } catch (e) {
    fail("Couldn't open file", e);
  }
}

/// Ctrl+S / Ctrl+Shift+S. Opens a dialog for `saveAs` or a tab with no path yet.
/// Returns true if saved. The saved content is the current SQL at write time.
export async function saveSqlFile(tabId: string, saveAs = false): Promise<boolean> {
  const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  let path = tab.filePath;
  try {
    if (!path || saveAs) {
      const chosen = await save({
        filters: SQL_FILTERS,
        defaultPath: tab.filePath ?? `${tab.title}.sql`,
      });
      if (typeof chosen !== "string") return false; // cancelled
      path = chosen;
    }
    // Read the current content at write time (it may have been edited during the dialog).
    const sql = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.sql ?? tab.sql;
    await writeTextFile(path, sql);
    useTabsStore.getState().markSaved(tabId, path, sql);
    return true;
  } catch (e) {
    fail("Couldn't save file", e);
    return false;
  }
}
