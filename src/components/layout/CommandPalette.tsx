import { useMemo } from "react";
import { Command } from "cmdk";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useUiStore } from "@/stores/uiStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";
import { useTabsStore } from "@/stores/tabsStore";
import { connectProfile, focusConnection } from "@/lib/connectionActions";
import { openSqlFile, saveSqlFile } from "@/lib/fileActions";
import { openServerActivity } from "@/lib/activityQuery";
import { runFormatActive } from "@/lib/editorRun";
import { refreshSchema } from "@/lib/api";

// "Bind this tab to …" is the explicit, deliberate old behavior: rebind the active
// tab to the given connection — rejected if a query is running, a tx is open, or a
// page is pending.
function bindTab(connectionId: string) {
  const tabId = useTabsStore.getState().activeTabId;
  if (tabId && !useTabsStore.getState().setConnection(tabId, connectionId)) {
    toast.error("Can't rebind this tab's connection", {
      description: "Finish the running query, open transaction, or pending results first.",
    });
  }
}

// The Ctrl+K command palette: commands + connection switching + opening tables. cmdk
// applies its own fuzzy filter; items are searched by their `value`.
export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);

  // "Switch connection" binds the active TAB, not the global active connection —
  // Explorer/completion/the Tables group always follow the tab.
  const tabConnectionId = useTabsStore((s) => s.active()?.connectionId ?? null);
  const connections = useConnectionStore((s) => s.connections);
  const profiles = useConnectionStore((s) => s.profiles);
  const snapshotEntry = useSchemaStore((s) =>
    tabConnectionId ? s.byConnection[tabConnectionId] : undefined,
  );

  // The active connection's tables (schema.name) — for opening quickly from the palette.
  const tables = useMemo(() => {
    const snap = snapshotEntry?.snapshot;
    if (!snap) return [];
    const out: { schema: string; name: string }[] = [];
    for (const sc of snap.schemas) {
      if (sc.is_system) continue;
      for (const r of sc.relations) out.push({ schema: sc.name, name: r.name });
    }
    return out;
  }, [snapshotEntry]);

  const run = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  const openTable = (schema: string, name: string) => {
    // Cell editability is derived from the executed single-table SELECT itself.
    const id = useTabsStore
      .getState()
      .addTab(`SELECT * FROM "${schema}"."${name}" LIMIT 500;`, tabConnectionId);
    void useTabsStore.getState().run(id);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="w-[520px] p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command
          className="[&_[cmdk-input]]:h-10 [&_[cmdk-input]]:w-full [&_[cmdk-input]]:border-b [&_[cmdk-input]]:border-border [&_[cmdk-input]]:bg-transparent [&_[cmdk-input]]:px-3 [&_[cmdk-input]]:text-sm [&_[cmdk-input]]:outline-none"
          loop
        >
          <Command.Input placeholder="Type a command or search tables…" autoFocus />
          <Command.List className="max-h-[340px] overflow-auto p-1">
            <Command.Empty className="p-3 text-xs text-fg-muted">No results.</Command.Empty>

            <Command.Group heading="Commands" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-muted">
              <Item onSelect={() => run(() => useTabsStore.getState().addTab(""))}>New tab</Item>
              <Item onSelect={() => run(() => void openSqlFile())}>Open .sql file…</Item>
              <Item
                onSelect={() =>
                  run(() => {
                    const id = useTabsStore.getState().activeTabId;
                    if (id) void saveSqlFile(id);
                  })
                }
              >
                Save file
              </Item>
              <Item
                onSelect={() =>
                  run(() => {
                    const id = useTabsStore.getState().activeTabId;
                    if (id) void saveSqlFile(id, true);
                  })
                }
              >
                Save file as…
              </Item>
              <Item value="format sql beautify" onSelect={() => run(() => runFormatActive())}>
                Format SQL (Ctrl+K in editor)
              </Item>
              <Item onSelect={() => run(() => useUiStore.getState().toggleSidebar())}>
                Toggle sidebar
              </Item>
              <Item onSelect={() => run(() => useUiStore.getState().toggleResults())}>
                Toggle results panel
              </Item>
              {tabConnectionId && (
                <Item onSelect={() => run(() => openServerActivity(tabConnectionId))}>
                  Show server activity
                </Item>
              )}
              <Item onSelect={() => run(() => useUiStore.getState().setSettingsOpen(true))}>
                Open settings
              </Item>
              {tabConnectionId && (
                <Item onSelect={() => run(() => void refreshSchema(tabConnectionId))}>
                  Refresh schema
                </Item>
              )}
            </Command.Group>

            {(Object.keys(connections).length > 0 || profiles.length > 0) && (
              <Command.Group heading="Connections" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-muted">
                {Object.values(connections).map((c) => (
                  <Item
                    key={`open-${c.connection_id}`}
                    value={`open tab on ${c.database} ${c.user}`}
                    onSelect={() => run(() => focusConnection(c.connection_id))}
                  >
                    Open tab on {c.database}
                    {c.connection_id === tabConnectionId ? " (active)" : ""}
                  </Item>
                ))}
                {Object.values(connections)
                  .filter((c) => c.connection_id !== tabConnectionId)
                  .map((c) => (
                    <Item
                      key={`bind-${c.connection_id}`}
                      value={`bind this tab to ${c.database} ${c.user}`}
                      onSelect={() => run(() => bindTab(c.connection_id))}
                    >
                      Bind this tab to {c.database}
                    </Item>
                  ))}
                {profiles
                  .filter((p) => !Object.values(connections).some((c) => c.profile_id === p.id))
                  .map((p) => (
                    <Item
                      key={`profile-${p.id}`}
                      value={`connect ${p.name} ${p.database}`}
                      onSelect={() => run(() => void connectProfile(p.id))}
                    >
                      Connect: {p.name}
                    </Item>
                  ))}
              </Command.Group>
            )}

            {tables.length > 0 && (
              <Command.Group heading="Tables" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-muted">
                {tables.map((t) => (
                  <Item
                    key={`tbl-${t.schema}.${t.name}`}
                    value={`${t.schema}.${t.name}`}
                    onSelect={() => run(() => openTable(t.schema, t.name))}
                  >
                    {t.schema}.{t.name}
                  </Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function Item({
  children,
  value,
  onSelect,
}: {
  children: React.ReactNode;
  value?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center rounded px-2 py-1.5 text-xs text-fg data-[selected=true]:bg-fg data-[selected=true]:text-bg"
    >
      {children}
    </Command.Item>
  );
}
