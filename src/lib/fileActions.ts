// .sql aç/kaydet orkestrasyonu (design 15 §P1-U4). Native diyalog
// (@tauri-apps/plugin-dialog) + kendi read/write komutlarımız. Toolbar,
// kısayollar ve palette bu tek kaynaktan geçer.
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

/// Ctrl+O: dosya seç → içeriği yeni tab'a (başlık = dosya adı, aktif bağlantıyı devralır).
export async function openSqlFile() {
  try {
    const selected = await open({ multiple: false, filters: SQL_FILTERS });
    if (typeof selected !== "string") return; // iptal
    const content = await readTextFile(selected);
    const connId = useConnectionStore.getState().activeConnectionId;
    useTabsStore.getState().openFileTab(content, selected, connId);
  } catch (e) {
    fail("Couldn't open file", e);
  }
}

/// Ctrl+S / Ctrl+Shift+S. `saveAs` ya da yolu olmayan tab için diyalog açılır.
/// true = kaydedildi. Kaydedilen içerik yazma anındaki güncel SQL'dir.
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
      if (typeof chosen !== "string") return false; // iptal
      path = chosen;
    }
    // Yazma anındaki güncel içeriği al (diyalog sırasında düzenlenmiş olabilir).
    const sql = useTabsStore.getState().tabs.find((t) => t.id === tabId)?.sql ?? tab.sql;
    await writeTextFile(path, sql);
    useTabsStore.getState().markSaved(tabId, path, sql);
    return true;
  } catch (e) {
    fail("Couldn't save file", e);
    return false;
  }
}
