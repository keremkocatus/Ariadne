import { useEffect, useState } from "react";
import { ResultGrid } from "@/components/grid/ResultGrid";
import { CellDialog, type CellEditContext } from "@/components/grid/CellDialog";
import { ObjectInfoView } from "@/components/editor/ObjectInfoPanel";
import { errorTitle, readOnlyProfileHint } from "@/lib/errors";
import type { AriadneError, StatementResult } from "@/lib/api";
import { useTabsStore } from "@/stores/tabsStore";
import { useConnectionStore } from "@/stores/connectionStore";

/// The active tab's results area. On a partial result the error banner is shown at
/// the TOP with the accumulated results BELOW it. Alt+F1 object info temporarily
/// covers the result as an overlay.
export function ResultArea({ tabId, onFetchMore }: { tabId: string; onFetchMore: () => void }) {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === tabId));
  const setInfoResult = useTabsStore((s) => s.setInfoResult);
  const patchCell = useTabsStore((s) => s.patchCell);
  const isReadOnly = useConnectionStore((s) => s.isReadOnly(tab?.connectionId ?? null));
  // The selected cell for the view/edit popup.
  const [cell, setCell] = useState<{ rowIndex: number; colIndex: number } | null>(null);
  // Close the open dialog on a new query (columns reference changed) or a tab change
  // — otherwise stale row/column indexes could apply to the new result.
  useEffect(() => setCell(null), [tab?.id, tab?.query.columns]);
  const q = tab?.query;
  if (!q) return null;

  // Object-info overlay: the result state is NOT overwritten; it returns on close.
  if (q.infoResult) {
    return <ObjectInfoView info={q.infoResult} onClose={() => setInfoResult(tabId, null)} />;
  }

  const cancelled = q.error?.kind === "query_cancelled";
  const showError = q.error && !cancelled;
  const hasRows = q.columns.length > 0;
  const hasExtra = q.extra.length > 0;

  return (
    <div className="flex h-full flex-col">
      {q.ranSelection && (hasRows || hasExtra || showError) && (
        <div className="shrink-0 border-b border-border bg-bg-elev/40 px-3 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">
          ran selection
        </div>
      )}
      {cancelled && <p className="p-3 font-mono text-xs text-fg-muted">Query cancelled.</p>}
      {showError && <ErrorBanner err={q.error!} readOnlyHint={readOnlyProfileHint(q.error!, isReadOnly)} />}
      {q.frozen && (
        <div className="shrink-0 border-b border-warn/40 bg-warn/5 px-3 py-1.5 text-[11px] text-warn">
          Result expired after being idle — re-run the query to continue paging.
        </div>
      )}
      {hasRows ? (
        <div className="min-h-0 flex-1">
          <ResultGrid
            columns={q.columns}
            rows={q.rows}
            hasMore={q.hasMore}
            fetchingMore={q.fetchingMore}
            capped={q.capped}
            fetchedTotal={q.fetchedTotal}
            elapsedMs={q.elapsedMs}
            onFetchMore={onFetchMore}
            onCellActivate={(rowIndex, colIndex) => setCell({ rowIndex, colIndex })}
          />
        </div>
      ) : hasExtra ? (
        <AffectedList extra={q.extra} />
      ) : !q.error ? (
        <p className="p-3 font-mono text-xs text-fg-muted">
          {q.running ? "Running…" : "Results will appear here. Run with Ctrl+Enter."}
        </p>
      ) : null}

      {cell && tab?.connectionId && q.rows[cell.rowIndex] && q.columns[cell.colIndex] && (
        <CellDialog
          ctx={
            {
              connectionId: tab.connectionId,
              sourceTable: tab.sourceTable,
              readOnly: isReadOnly,
              columns: q.columns,
              row: q.rows[cell.rowIndex],
              rowIndex: cell.rowIndex,
              colIndex: cell.colIndex,
            } satisfies CellEditContext
          }
          onClose={() => setCell(null)}
          onSaved={(r, c, v) => patchCell(tabId, r, c, v)}
        />
      )}
    </div>
  );
}

function ErrorBanner({ err, readOnlyHint }: { err: AriadneError; readOnlyHint?: string | null }) {
  return (
    <div className="shrink-0 overflow-auto border-b border-danger/30 p-3 font-mono text-xs">
      <div className="text-danger">
        <span className="font-semibold">{errorTitle(err)}</span>
        {err.sqlstate && <span className="text-fg-muted"> · {err.sqlstate}</span>}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-danger">{err.message}</p>
      {readOnlyHint && <p className="mt-1 whitespace-pre-wrap text-warn">{readOnlyHint}</p>}
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

function AffectedList({ extra }: { extra: StatementResult[] }) {
  return (
    <div className="space-y-1 p-3 font-mono text-xs">
      {extra.map((s, i) => (
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
