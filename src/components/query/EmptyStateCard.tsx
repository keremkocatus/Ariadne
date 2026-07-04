// Empty-state welcome card. On a disconnected + untouched (pristine) active tab it
// draws a light invite over the editor: Connect / Open .sql + a shortcut list. The
// overlay passes clicks through (pointer-events-none); only the buttons are clickable.
// The first keystroke makes the tab non-pristine and the card disappears on its own.
import { Plug, FolderOpen } from "lucide-react";
import { useTabsStore, isPristine } from "@/stores/tabsStore";
import { useUiStore } from "@/stores/uiStore";
import { openSqlFile } from "@/lib/fileActions";

const SHORTCUTS: [string, string][] = [
  ["Ctrl+K", "Connections / command palette"],
  ["Ctrl+Enter", "Run query (or selection)"],
  ["Ctrl+P", "Search schema"],
  ["Ctrl+O", "Open .sql file"],
  ["Ctrl+T", "New tab"],
];

export function EmptyStateCard() {
  const active = useTabsStore((s) => s.active());
  const setConnectMenuOpen = useUiStore((s) => s.setConnectMenuOpen);

  // Visible only on a disconnected + pristine tab; otherwise render nothing.
  if (!active || active.connectionId || !isPristine(active)) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
      <div className="pointer-events-auto w-full max-w-sm rounded-lg border border-border bg-bg-elev/80 p-5 shadow-xl backdrop-blur-sm">
        <h2 className="text-sm font-medium text-fg">Welcome to Ariadne</h2>
        <p className="mt-1 text-xs text-fg-muted">Connect to a database to start querying.</p>
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => setConnectMenuOpen(true)}
            className="inline-flex items-center gap-1.5 rounded border border-fg bg-fg px-2.5 py-1 text-xs font-medium text-bg hover:opacity-90"
          >
            <Plug size={12} /> Connect…
          </button>
          <button
            onClick={() => void openSqlFile()}
            className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-xs hover:border-fg-muted"
          >
            <FolderOpen size={12} /> Open .sql
          </button>
        </div>
        <dl className="mt-4 space-y-1 border-t border-border pt-3">
          {SHORTCUTS.map(([keys, label]) => (
            <div key={keys} className="flex items-center gap-3 text-[11px]">
              <dt className="w-24 shrink-0 font-mono text-fg-muted">{keys}</dt>
              <dd className="text-fg-muted">{label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
