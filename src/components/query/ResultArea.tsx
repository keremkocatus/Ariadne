import { ResultGrid } from "@/components/grid/ResultGrid";
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
    return (
      <pre className="whitespace-pre-wrap p-3 font-mono text-xs text-danger">
        [{q.error.kind}
        {q.error.sqlstate ? ` ${q.error.sqlstate}` : ""}] {q.error.message}
        {q.error.hint ? `\nHINT: ${q.error.hint}` : ""}
      </pre>
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
