import { ResultGrid } from "@/components/grid/ResultGrid";
import { errorTitle } from "@/lib/errors";
import { useTabsStore } from "@/stores/tabsStore";

/// Aktif tab'ın sonuç bölgesi: hata bandı / grid / affected özeti / boş durum.
export function ResultArea({ tabId, onFetchMore }: { tabId: string; onFetchMore: () => void }) {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === tabId));
  const q = tab?.query;
  if (!q) return null;

  if (q.error) {
    // İptal edilen sorgu hata gibi gösterilmez (design 05 §3).
    if (q.error.kind === "query_cancelled") {
      return <p className="p-3 font-mono text-xs text-fg-muted">Query cancelled.</p>;
    }
    const err = q.error;
    return (
      <div className="overflow-auto p-3 font-mono text-xs">
        <div className="text-danger">
          <span className="font-semibold">{errorTitle(err)}</span>
          {err.sqlstate && <span className="text-fg-muted"> · {err.sqlstate}</span>}
        </div>
        <p className="mt-1 whitespace-pre-wrap text-danger">{err.message}</p>
        {err.hint && <p className="mt-1 whitespace-pre-wrap text-warn">HINT: {err.hint}</p>}
        {err.detail && (
          <details className="mt-1 text-fg-muted">
            <summary className="cursor-pointer select-none">Detail</summary>
            <pre className="mt-1 whitespace-pre-wrap">{err.detail}</pre>
          </details>
        )}
      </div>
    );
  }
  if (q.columns.length > 0) {
    return (
      <ResultGrid
        columns={q.columns}
        rows={q.rows}
        hasMore={q.hasMore}
        fetchingMore={q.fetchingMore}
        capped={q.capped}
        fetchedTotal={q.fetchedTotal}
        elapsedMs={q.elapsedMs}
        onFetchMore={onFetchMore}
      />
    );
  }
  if (q.extra.length > 0) {
    return (
      <div className="space-y-1 p-3 font-mono text-xs">
        {q.extra.map((s, i) => (
          <div key={i} className={s.kind === "empty" ? "text-fg-muted" : ""}>
            {s.kind === "affected"
              ? `${s.command} — ${s.row_count} row(s)`
              : s.kind === "empty"
                ? s.command
                : ""}
          </div>
        ))}
      </div>
    );
  }
  return (
    <p className="p-3 font-mono text-xs text-fg-muted">
      {q.running ? "Running…" : "Results will appear here. Run with Ctrl+Enter."}
    </p>
  );
}
