import { useEffect, useState } from "react";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";
import { useTabsStore } from "@/stores/tabsStore";
import { RoBadge } from "@/components/connection/RoBadge";
import { dbStats, type DbStats } from "@/lib/api";

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
  const stats = useDbStats(info ? tabConnectionId : null);

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
      <div className="ml-auto flex items-center gap-2">
        {stats && <StatsStrip stats={stats} />}
        <span>v0.0.2</span>
      </div>
    </footer>
  );
}

/// Versiyon etiketinin solundaki kompakt metrik şeridi (design 20 §P1-Y3 M5):
/// bağlantı sayısı · cache hit · DB boyutu. CPU/RAM yok (kapsam dışı, design 20 §6).
function StatsStrip({ stats }: { stats: DbStats }) {
  const conns =
    stats.max_connections != null
      ? `${stats.active_connections}/${stats.max_connections} conns`
      : `${stats.active_connections} conns`;
  const cache = stats.cache_hit_ratio != null ? `${Math.round(stats.cache_hit_ratio * 100)}% cache` : null;
  const size = stats.db_size_bytes != null ? formatBytes(stats.db_size_bytes) : null;
  return (
    <span
      className="flex items-center gap-2 tabular-nums"
      title="Client backends vs max_connections · shared-buffer cache hit ratio · on-disk database size (refreshed every 30s)"
    >
      <span>⚡ {conns}</span>
      {cache && <span>· {cache}</span>}
      {size && <span>· {size}</span>}
    </span>
  );
}

/// Aktif bağlantının DB istatistiklerini 30 sn'de bir çeker (design 20 M5). Bağlantı
/// yok/kapalıysa null → şerit gizli. Bağlantı/tab değişince sıfırlanır ve hemen bir
/// örnek alınır. Hata sessizce yutulur (şerit görünmez; yanıltıcı değer üretilmez).
function useDbStats(connectionId: string | null): DbStats | null {
  const [stats, setStats] = useState<DbStats | null>(null);
  useEffect(() => {
    if (!connectionId) {
      setStats(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      dbStats(connectionId)
        .then((s) => !cancelled && setStats(s))
        .catch(() => !cancelled && setStats(null));
    };
    setStats(null);
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [connectionId]);
  return stats;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function relTime(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}
