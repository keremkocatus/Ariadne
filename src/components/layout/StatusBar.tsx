import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";

/// Alt durum çubuğu: profil renk şeridi + sunucu + cache tazeliği (design 07 §2).
export function StatusBar() {
  const activeInfo = useConnectionStore((s) => s.activeInfo());
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const cacheEntry = useSchemaStore((s) =>
    activeConnectionId ? s.byConnection[activeConnectionId] : undefined,
  );

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-2 text-[11px] text-fg-muted">
      {activeInfo ? (
        <>
          <span className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: activeInfo.color || "#4ade80" }}
            />
            {activeInfo.database} · PostgreSQL {activeInfo.server_version.split(" ")[0]}
          </span>
          <span>cache: {cacheEntry?.snapshot ? relTime(cacheEntry.snapshot.fetched_at) : "—"}</span>
        </>
      ) : (
        <span>no connection</span>
      )}
      <span className="ml-auto">v0.0.0</span>
    </footer>
  );
}

function relTime(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}
