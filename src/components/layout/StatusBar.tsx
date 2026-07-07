import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSchemaStore } from "@/stores/schemaStore";
import { useTabsStore } from "@/stores/tabsStore";
import { RoBadge } from "@/components/connection/RoBadge";
import { formatBytes } from "@/lib/format";
import { dbStats, type DbStats } from "@/lib/api";

/// The bottom status bar: the active TAB's connection (profile color stripe + server
/// + cache freshness), not the global active connection.
export function StatusBar() {
  const tabConnectionId = useTabsStore((s) => s.active()?.connectionId ?? null);
  const info = useConnectionStore((s) => (tabConnectionId ? (s.connections[tabConnectionId] ?? null) : null));
  const readOnly = useConnectionStore((s) => s.isReadOnly(tabConnectionId));
  const cacheEntry = useSchemaStore((s) =>
    tabConnectionId ? s.byConnection[tabConnectionId] : undefined,
  );
  const closed = !!tabConnectionId && !info;
  const stats = useDbStats(info ? tabConnectionId : null);
  const version = useAppVersion();

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
        {version && <span>v{version}</span>}
      </div>
    </footer>
  );
}

/// The compact metric strip to the left of the version label: connection count ·
/// cache hit · database size. No CPU/RAM (out of scope).
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
      title="Client backends vs max_connections · shared-buffer cache hit ratio · on-disk database size (refreshed every 60s while the window is focused)"
    >
      <span>⚡ {conns}</span>
      {cache && <span>· {cache}</span>}
      {size && <span>· {size}</span>}
    </span>
  );
}

/// Fetches the active connection's DB stats every 60s — but only while the window is
/// focused AND visible. An unpaused poll is what kept one DB connection perpetually
/// warm per open window (it always beat the pool's 5-minute idle timeout), so a
/// backgrounded window would hold a server connection forever. Both signals are
/// needed: visibilitychange misses an unfocused-but-visible window, focus misses a
/// hidden one. Resuming takes a sample immediately. Errors are swallowed silently
/// (the strip hides; no fake value).
function useDbStats(connectionId: string | null): DbStats | null {
  const [stats, setStats] = useState<DbStats | null>(null);
  useEffect(() => {
    if (!connectionId) {
      setStats(null);
      return;
    }
    let cancelled = false;
    let focused = document.hasFocus();
    let visible = !document.hidden;
    let intervalId: number | null = null;

    const tick = () => {
      dbStats(connectionId)
        .then((s) => !cancelled && setStats(s))
        .catch(() => !cancelled && setStats(null));
    };
    const start = () => {
      if (intervalId !== null || cancelled || !focused || !visible) return;
      tick();
      intervalId = window.setInterval(tick, 60_000);
    };
    const stop = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };
    const update = () => (focused && visible ? start() : stop());

    const onVisibility = () => {
      visible = !document.hidden;
      update();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload }) => {
      focused = payload;
      update();
    });

    setStats(null);
    start();
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      void unlistenPromise.then((un) => un()).catch(() => {});
    };
  }, [connectionId]);
  return stats;
}

/// The real app version from tauri.conf.json — a hardcoded label here went stale
/// once and displayed the wrong version for a whole release.
function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);
  return version;
}

function relTime(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}
