import { useEffect, useState } from "react";
import { Check, Minus, X } from "lucide-react";
import { ResultGrid } from "@/components/grid/ResultGrid";
import { CellDialog, type CellEditContext } from "@/components/grid/CellDialog";
import { ObjectInfoView } from "@/components/editor/ObjectInfoPanel";
import { PlanView } from "@/components/query/PlanView";
import { errorTitle, readOnlyProfileHint } from "@/lib/errors";
import { formatDuration } from "@/lib/pgFormat";
import { cn } from "@/lib/utils";
import type { AriadneError, ColumnMeta } from "@/lib/api";
import { useTabsStore, type QueryState, type StatementSummary } from "@/stores/tabsStore";
import { useConnectionStore } from "@/stores/connectionStore";

/// One grid the results area can show. Only the last result set of a run is "live":
/// it may have more pages behind a cursor and its cells may be editable.
interface ResultSetView {
  columns: ColumnMeta[];
  rows: (string | null)[][];
  elapsedMs: number;
  partial: boolean;
  live: boolean;
  preview: string;
}

function resultSets(q: QueryState): ResultSetView[] {
  const sets: ResultSetView[] = q.earlier.map((r) => ({ ...r, live: false }));
  // Keyed on the statement rather than on having columns: `SELECT FROM t` returns rows
  // with none, and skipping it would shift every Messages link by one.
  const main = q.statements.findLast((s) => s.kind === "rows");
  if (main) {
    sets.push({
      columns: q.columns,
      rows: q.rows,
      elapsedMs: q.elapsedMs,
      partial: q.partial,
      live: true,
      preview: main.preview,
    });
  }
  return sets;
}

/// The active tab's results area. A run with several statements gets a strip of
/// result tabs plus a Messages list; a single SELECT shows just its grid. On a partial
/// result the error banner is shown at the TOP with what did run BELOW it. Alt+F1
/// object info and execution plans temporarily cover the result as overlays.
export function ResultArea({ tabId, onFetchMore }: { tabId: string; onFetchMore: () => void }) {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === tabId));
  const setInfoResult = useTabsStore((s) => s.setInfoResult);
  const setPlan = useTabsStore((s) => s.setPlan);
  const explain = useTabsStore((s) => s.explain);
  const patchCell = useTabsStore((s) => s.patchCell);
  const isReadOnly = useConnectionStore((s) => s.isReadOnly(tab?.connectionId ?? null));
  // Which view is showing: a result-set index, or the Messages list.
  const [view, setView] = useState<number | "messages">(0);
  // The selected cell for the view/edit popup.
  const [cell, setCell] = useState<{ rowIndex: number; colIndex: number } | null>(null);
  const q = tab?.query;
  const sets = q ? resultSets(q) : [];

  // A new run starts on its last result set (the one a lone SELECT would show), or on
  // Messages when nothing returned rows.
  useEffect(() => {
    setView(sets.length > 0 ? sets.length - 1 : "messages");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.id, q?.queryId, q?.running]);
  // Close the open dialog on a new query, a tab change or a view change — otherwise
  // stale row/column indexes could apply to a different result.
  useEffect(() => setCell(null), [tab?.id, q?.columns, view]);

  if (!q || !tab) return null;

  // Overlays: the result state is NOT overwritten; it returns on close.
  if (q.infoResult) {
    return (
      <ObjectInfoView
        info={q.infoResult}
        connectionId={tab.connectionId}
        onClose={() => setInfoResult(tabId, null)}
      />
    );
  }
  if (q.plan) {
    const plan = q.plan;
    return (
      <PlanView
        plan={plan}
        onClose={() => setPlan(tabId, null)}
        onRerun={(analyze) =>
          void explain(tabId, { analyze, sql: plan.sql, selectionOffset: plan.selectionOffset })
        }
      />
    );
  }

  const cancelled = q.error?.kind === "query_cancelled";
  const showError = q.error && !cancelled;
  const hasMessages = q.statements.length > 0;
  // Messages earns a tab when it says more than the grid already does.
  const showMessagesTab = hasMessages && (q.statements.length > 1 || sets.length === 0);
  const showStrip = sets.length + (showMessagesTab ? 1 : 0) > 1;
  const current = typeof view === "number" ? sets[Math.min(view, sets.length - 1)] : undefined;
  const notRun = q.totalStatements - q.statements.length;

  return (
    <div className="flex h-full flex-col">
      {showStrip && (
        <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-border bg-bg-elev/40 px-1.5" role="tablist">
          {sets.map((s, i) => (
            <ViewTab key={i} active={current === s} onClick={() => setView(i)} title={s.preview}>
              Result {i + 1}
              <span className="tabular-nums text-fg-subtle">{s.rows.length.toLocaleString()}</span>
            </ViewTab>
          ))}
          {showMessagesTab && (
            <ViewTab active={!current} onClick={() => setView("messages")}>
              Messages
              <span className={cn("tabular-nums", showError ? "text-danger" : "text-fg-subtle")}>
                {q.statements.length}
              </span>
            </ViewTab>
          )}
          {q.ranSelection && <span className="ml-auto pr-1.5 text-[10px] uppercase tracking-wide text-fg-subtle">ran selection</span>}
        </div>
      )}
      {!showStrip && q.ranSelection && (hasMessages || showError) && (
        <div className="shrink-0 border-b border-border bg-bg-elev/40 px-3 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">
          ran selection
        </div>
      )}
      {cancelled && <p className="p-3 font-mono text-xs text-fg-muted">Query cancelled.</p>}
      {showError && (
        <ErrorBanner
          err={q.error!}
          statementNumber={q.totalStatements > 1 ? q.statements.length : null}
          readOnlyHint={readOnlyProfileHint(q.error!, isReadOnly)}
        />
      )}
      {q.frozen && current?.live && (
        <div className="shrink-0 border-b border-warn/40 bg-warn/5 px-3 py-1.5 text-[11px] text-warn">
          Result expired after being idle — re-run the query to continue paging.
        </div>
      )}
      {current?.partial && (
        <div className="shrink-0 border-b border-border bg-bg-elev/40 px-3 py-1 text-[11px] text-fg-muted">
          Showing the first {current.rows.length.toLocaleString()} rows. The statement ran to completion,
          but only a read-only query that ends a script can be paged — run it on its own to scroll
          through the rest.
        </div>
      )}

      {current ? (
        <div className="min-h-0 flex-1">
          <ResultGrid
            columns={current.columns}
            rows={current.rows}
            hasMore={current.live && q.hasMore}
            fetchingMore={current.live && q.fetchingMore}
            capped={current.live && q.capped}
            fetchedTotal={current.live ? q.fetchedTotal : current.rows.length}
            elapsedMs={current.elapsedMs}
            onFetchMore={onFetchMore}
            onCellActivate={(rowIndex, colIndex) => setCell({ rowIndex, colIndex })}
          />
        </div>
      ) : hasMessages ? (
        <Messages
          statements={q.statements}
          notRun={q.error ? notRun : 0}
          onOpenResult={sets.length > 0 ? setView : undefined}
        />
      ) : !q.error ? (
        <p className="p-3 font-mono text-xs text-fg-muted">
          {q.running ? "Running…" : "Results will appear here. Run with Ctrl+Enter."}
        </p>
      ) : null}

      {cell && current && tab.connectionId && current.rows[cell.rowIndex] && current.columns[cell.colIndex] && (
        <CellDialog
          ctx={
            {
              connectionId: tab.connectionId,
              // Editing needs the executed statement's source table, which is only
              // tracked for the live result; earlier result sets open read-only.
              sourceTable: current.live ? q.sourceTable : null,
              readOnly: isReadOnly,
              columns: current.columns,
              row: current.rows[cell.rowIndex],
              rowIndex: cell.rowIndex,
              colIndex: cell.colIndex,
            } satisfies CellEditContext
          }
          onClose={() => setCell(null)}
          onSaved={(r, c, v) => current.live && patchCell(tabId, r, c, v)}
        />
      )}
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-5 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors",
        active ? "bg-bg-hover text-fg" : "text-fg-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function ErrorBanner({
  err,
  statementNumber,
  readOnlyHint,
}: {
  err: AriadneError;
  /** 1-based position of the failed statement, for a multi-statement run. */
  statementNumber: number | null;
  readOnlyHint?: string | null;
}) {
  return (
    <div className="max-h-[45%] shrink-0 select-text overflow-auto border-b border-danger/30 bg-danger/5 p-3 font-mono text-xs">
      <div className="text-danger">
        <span className="font-semibold">{errorTitle(err)}</span>
        {err.sqlstate && <span className="text-fg-muted"> · {err.sqlstate}</span>}
        {statementNumber != null && statementNumber > 0 && (
          <span className="text-fg-muted"> · statement {statementNumber}</span>
        )}
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

/// What each statement of the run did: a psql-style transcript as a table.
function Messages({
  statements,
  notRun,
  onOpenResult,
}: {
  statements: StatementSummary[];
  notRun: number;
  onOpenResult?: (index: number) => void;
}) {
  const totalMs = statements.reduce((n, s) => n + s.elapsedMs, 0);
  const outcome = (s: StatementSummary): string => {
    if (s.kind === "failed") return "failed";
    if (s.rowCount == null) return "done";
    const noun = s.rowCount === 1 ? "row" : "rows";
    return `${s.rowCount.toLocaleString()} ${noun}${s.kind === "affected" ? " affected" : ""}`;
  };
  return (
    <div className="min-h-0 flex-1 select-text overflow-auto">
      <table className="w-full border-separate border-spacing-0 font-mono text-[11px]">
        <tbody>
          {statements.map((s, i) => (
            <tr key={i} className={cn("hover:bg-bg-hover/60", s.kind === "failed" && "bg-danger/5")}>
              <td className="w-9 border-b border-border/40 py-1 pl-3 pr-1 text-right tabular-nums text-fg-subtle">
                {i + 1}
              </td>
              <td className="w-5 border-b border-border/40 py-1">
                {s.kind === "failed" ? (
                  <X size={11} className="text-danger" />
                ) : (
                  <Check size={11} className="text-ok" />
                )}
              </td>
              <td className="whitespace-nowrap border-b border-border/40 py-1 pr-4 font-semibold">{s.command}</td>
              <td
                className={cn(
                  "whitespace-nowrap border-b border-border/40 py-1 pr-4",
                  s.kind === "failed" ? "text-danger" : "text-fg-muted",
                )}
              >
                {s.resultIndex != null && onOpenResult ? (
                  <button
                    className="underline decoration-border-strong underline-offset-2 hover:text-fg"
                    onClick={() => onOpenResult(s.resultIndex!)}
                    title="Show this result set"
                  >
                    {outcome(s)}
                  </button>
                ) : (
                  outcome(s)
                )}
              </td>
              <td className="whitespace-nowrap border-b border-border/40 py-1 pr-4 text-right tabular-nums text-fg-subtle">
                {formatDuration(s.elapsedMs)}
              </td>
              <td className="max-w-0 w-full truncate border-b border-border/40 py-1 pr-3 text-fg-muted" title={s.preview}>
                {s.preview}
              </td>
            </tr>
          ))}
          {notRun > 0 && (
            <tr>
              <td className="py-1 pl-3 pr-1" />
              <td className="py-1">
                <Minus size={11} className="text-fg-subtle" />
              </td>
              <td colSpan={4} className="py-1 text-fg-subtle">
                {notRun} more statement{notRun === 1 ? "" : "s"} not run
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="px-3 py-1.5 text-[10px] text-fg-subtle">
        {statements.length} statement{statements.length === 1 ? "" : "s"} · {formatDuration(totalMs)}
      </div>
    </div>
  );
}
