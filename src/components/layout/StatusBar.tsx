import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";
import { useTabsStore } from "@/stores/tabsStore";
import { RoBadge } from "@/components/connection/RoBadge";

/// Alt durum çubuğu: aktif TAB'ın bağlantısı (profil renk şeridi + sunucu +
/// cache tazeliği), global aktif bağlantı değil (design 12 §P1-M1).
export function StatusBar() {
  const tabConnectionId = useTabsStore((s) => s.active()?.connectionId ?? null);
  const info = useConnectionStore((s) => (tabConnectionId ? (s.connections[tabConnectionId] ?? null) : null));
  const readOnly = useConnectionStore((s) => s.isReadOnly(tabConnectionId));
  const cacheEntry = useSchemaStore((s) =>
    tabConnectionId ? s.byConnection[tabConnectionId] : undefined,
  );
  const closed = !!tabConnectionId && !info;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-2 text-[11px] text-fg-muted">
      {info ? (
        <>
          <span className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: info.color || "#4ade80" }}
            />
            {info.database} · PostgreSQL {info.server_version.split(" ")[0]}
          </span>
          {readOnly && <RoBadge />}
          <span>cache: {cacheEntry?.snapshot ? relTime(cacheEntry.snapshot.fetched_at) : "—"}</span>
        </>
      ) : closed ? (
        <span className="flex items-center gap-1.5 text-warn">
          <span className="h-2 w-2 rounded-full bg-warn" />
          connection closed
        </span>
      ) : (
        <span>no connection</span>
      )}
      <span className="ml-auto">v0.0.1</span>
    </footer>
  );
}

function relTime(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}
