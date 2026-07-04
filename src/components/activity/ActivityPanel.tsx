// Sunucu aktivite görünümü (design 17 §P1-V4). pg_stat_activity client
// backend'leri, 5 sn'de bir tazelenir (panel mount'luyken = görünürken). Satır
// tık → detay + Cancel/Terminate. Prod yangını personası (P2) için "kim ne
// koşuyor → şunu öldür" akışı.
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Search, Zap } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { listActivity, signalBackend, isAriadneError, type ActivityRow, type SignalMode } from "@/lib/api";

const POLL_MS = 5000;

export function ActivityPanel({ connectionId }: { connectionId: string | null }) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    if (!connectionId) return;
    listActivity(connectionId)
      .then((r) => {
        if (!mounted.current) return;
        setRows(r);
        setError(false);
      })
      .catch(() => mounted.current && setError(true));
  }, [connectionId]);

  useEffect(() => {
    mounted.current = true;
    if (!connectionId) {
      setRows(null);
      return;
    }
    setRows(null);
    refresh();
    const iv = setInterval(refresh, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(iv);
    };
  }, [connectionId, refresh]);

  const doSignal = async (pid: number, mode: SignalMode) => {
    if (!connectionId) return;
    try {
      const ok = await signalBackend(connectionId, pid, mode);
      if (!ok) toast.error("Backend not found or not permitted");
      else toast.success(mode === "cancel" ? `Cancel sent to ${pid}` : `Backend ${pid} terminated`);
    } catch (e) {
      toast.error("Signal failed", { description: isAriadneError(e) ? e.message : String(e) });
    }
    refresh();
  };

  if (!connectionId) return <Empty text="Select a connection" />;

  const q = search.trim().toLowerCase();
  const filtered = (rows ?? []).filter((r) =>
    !q
      ? true
      : String(r.pid).includes(q) ||
        (r.usename ?? "").toLowerCase().includes(q) ||
        r.query.toLowerCase().includes(q),
  );
  const sel = rows?.find((r) => r.pid === selectedPid) ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border p-1.5">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter pid / user / query…"
            className="w-full rounded border border-border bg-bg py-1 pl-6 pr-2 text-xs outline-none focus:border-fg-muted"
          />
        </div>
        <span className="text-[9px] uppercase tracking-wide text-fg-muted" title="Auto-refreshes every 5s">
          auto
        </span>
        <button
          title="Refresh now"
          onClick={refresh}
          className="rounded border border-border p-1 text-fg-muted hover:text-fg"
        >
          <RefreshCw size={13} className={cn(rows === null && !error && "animate-spin")} />
        </button>
      </div>

      {error && rows === null ? (
        <Empty text="Couldn't load activity" />
      ) : rows === null ? (
        <Empty text="Loading activity…" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {filtered.length === 0 && <Empty text="No client backends" />}
          {filtered.map((r) => (
            <button
              key={r.pid}
              onClick={() => setSelectedPid(r.pid === selectedPid ? null : r.pid)}
              className={cn(
                "flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-bg-elev",
                r.pid === selectedPid && "bg-bg-elev",
              )}
            >
              <StateDot row={r} />
              <span className="w-12 shrink-0 font-mono text-fg-muted">{r.pid}</span>
              <span className="w-16 shrink-0 truncate">{r.usename ?? "—"}</span>
              <span className="w-12 shrink-0 text-right font-mono text-[10px] text-fg-muted">
                {r.duration_ms != null ? fmtDuration(r.duration_ms) : ""}
              </span>
              <span className="flex-1 truncate font-mono text-[10px] text-fg-muted">
                {firstLine(r.query)}
              </span>
              {r.is_app && (
                <span className="shrink-0 rounded bg-fg/10 px-1 text-[9px] text-fg-muted">this app</span>
              )}
            </button>
          ))}
        </div>
      )}

      {sel && <ActivityDetail row={sel} onSignal={doSignal} />}
    </div>
  );
}

function ActivityDetail({
  row,
  onSignal,
}: {
  row: ActivityRow;
  onSignal: (pid: number, mode: SignalMode) => void;
}) {
  // Terminate iki adımlı onay ister (bağlantı kopar); satır değişince sıfırlanır.
  const [confirmKill, setConfirmKill] = useState(false);
  useEffect(() => setConfirmKill(false), [row.pid]);

  return (
    <div className="max-h-[50%] overflow-auto border-t border-border bg-bg-elev p-2 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium">pid {row.pid}</span>
        {row.is_app && <span className="rounded bg-fg/10 px-1 text-[9px] text-fg-muted">this app</span>}
        <span className="text-[10px] text-fg-muted">{row.state ?? "—"}</span>
      </div>
      <Meta label="Database" value={row.datname} />
      <Meta label="User" value={row.usename} />
      <Meta label="Client" value={row.client_addr} />
      <Meta label="App" value={row.application_name || null} />
      <Meta label="Wait" value={row.wait_event} />
      <Meta label="Duration" value={row.duration_ms != null ? fmtDuration(row.duration_ms) : null} />
      <Meta label="Query start" value={row.query_start} />
      <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded border border-border bg-bg p-1.5 font-mono text-[10px]">
        {row.query || "—"}
      </pre>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => onSignal(row.pid, "cancel")}
          className="rounded border border-border px-2 py-1 text-[11px] hover:border-fg-muted"
          title="pg_cancel_backend — stop the running query"
        >
          Cancel query
        </button>
        {confirmKill ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-danger">Terminate pid {row.pid}?</span>
            <button
              onClick={() => onSignal(row.pid, "terminate")}
              className="inline-flex items-center gap-1 rounded border border-danger/50 px-2 py-1 text-[11px] text-danger hover:bg-danger/10"
            >
              <Zap size={11} /> Terminate
            </button>
            <button
              onClick={() => setConfirmKill(false)}
              className="text-[11px] text-fg-muted hover:text-fg"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmKill(true)}
            className="inline-flex items-center gap-1 rounded border border-danger/40 px-2 py-1 text-[11px] text-danger hover:bg-danger/10"
            title="pg_terminate_backend — drop the whole connection"
          >
            <Zap size={11} /> Terminate…
          </button>
        )}
      </div>
    </div>
  );
}

function StateDot({ row }: { row: ActivityRow }) {
  // active=fg, idle in transaction=warn, lock bekleyen=danger, diğer=muted.
  const waiting = row.wait_event?.startsWith("Lock");
  const color = waiting
    ? "bg-danger"
    : row.state === "active"
      ? "bg-fg"
      : row.state === "idle in transaction"
        ? "bg-warn"
        : "bg-fg-muted/50";
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", color)} title={row.state ?? ""} />;
}

function Meta({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex gap-2 text-[11px]">
      <span className="w-20 shrink-0 text-fg-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate">{value ?? "—"}</span>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="p-3 text-xs text-fg-muted">{text}</div>;
}

function firstLine(q: string): string {
  const i = q.indexOf("\n");
  return i === -1 ? q : q.slice(0, i);
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}
