import { useMemo } from "react";
import { Command } from "cmdk";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useUiStore } from "@/stores/uiStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";
import { useTabsStore } from "@/stores/tabsStore";
import { refreshSchema } from "@/lib/api";

// Aktif tab'ı verilen bağlantıya bağlar — getState() ile TIKLAMA ANINDA okur
// (destructure edilmiş activeTabId değil), çünkü "Connect: profile" async connect()
// sonrası .then() içinde çağrılır; o sırada kullanıcı başka bir tab'a geçmiş olabilir.
function bindTab(connectionId: string) {
  const tabId = useTabsStore.getState().activeTabId;
  if (tabId && !useTabsStore.getState().setConnection(tabId, connectionId)) {
    toast.error("Can't switch this tab's connection", {
      description: "Finish the running query, open transaction, or pending results first.",
    });
  }
}

// Ctrl+K command palette (design 07 §3): komutlar + bağlantı geçişi + tablo açma.
// cmdk kendi fuzzy filtresini uygular; item'lar `value`'ları üzerinden aranır.
export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);

  // "Switch connection" aktif TAB'ı bağlar, global aktif bağlantıyı değil
  // (design 12 §P1-M1) — Explorer/completion/Tables grubu hep tab'ı takip eder.
  const tabConnectionId = useTabsStore((s) => s.active()?.connectionId ?? null);
  const connections = useConnectionStore((s) => s.connections);
  const profiles = useConnectionStore((s) => s.profiles);
  const snapshotEntry = useSchemaStore((s) =>
    tabConnectionId ? s.byConnection[tabConnectionId] : undefined,
  );

  // Aktif bağlantının tabloları (schema.name) — palette'ten hızlı açmak için.
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
              <Item onSelect={() => run(() => useUiStore.getState().toggleSidebar())}>
                Toggle sidebar
              </Item>
              <Item onSelect={() => run(() => useUiStore.getState().toggleResults())}>
                Toggle results panel
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
                    key={`conn-${c.connection_id}`}
                    value={`switch ${c.database} ${c.user}`}
                    onSelect={() => run(() => bindTab(c.connection_id))}
                  >
                    Switch to {c.database}
                    {c.connection_id === tabConnectionId ? " (active)" : ""}
                  </Item>
                ))}
                {profiles
                  .filter((p) => !Object.values(connections).some((c) => c.profile_id === p.id))
                  .map((p) => (
                    <Item
                      key={`profile-${p.id}`}
                      value={`connect ${p.name} ${p.database}`}
                      onSelect={() =>
                        run(() => {
                          void useConnectionStore
                            .getState()
                            .connect(p.id)
                            .then((id) => bindTab(id));
                        })
                      }
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
