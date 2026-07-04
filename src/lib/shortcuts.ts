import { useEffect } from "react";
import { useUiStore } from "@/stores/uiStore";
import { useTabsStore } from "@/stores/tabsStore";

/// Global (editör dışı) kısayollar (design 07 §3). Editör-içi kısayollar
/// (Ctrl+Enter/E, Alt+F1, Ctrl+D) SqlEditor'da Monaco komutu olarak kayıtlı.
/// Store'lara `getState()` ile erişildiği için effect'in bağımlılığı yoktur.
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === "b") {
        e.preventDefault();
        useUiStore.getState().toggleSidebar();
      } else if (e.ctrlKey && k === "t") {
        e.preventDefault();
        useTabsStore.getState().addTab("");
      } else if (e.ctrlKey && k === "w") {
        e.preventDefault();
        const id = useTabsStore.getState().activeTabId;
        if (id) useTabsStore.getState().closeTab(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
