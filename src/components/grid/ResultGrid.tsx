import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import { toDelimited, toJson, toMarkdown, copyText } from "@/lib/clipboard";
import type { ColumnMeta } from "@/lib/api";

const ROW_H = 24;
const COL_W = 168;
// Above this row count, generating JSON/Markdown could block the UI thread; those
// items are disabled while the CSV/TSV path stays open.
const HEAVY_FORMAT_LIMIT = 50_000;

interface Props {
  columns: ColumnMeta[];
  rows: (string | null)[][];
  hasMore: boolean;
  fetchingMore: boolean;
  capped: boolean;
  fetchedTotal: number;
  estimatedTotal?: number | null;
  elapsedMs: number;
  onFetchMore: () => void;
  /// Double-click a cell → the view/edit popup. Managed by ResultArea.
  onCellActivate?: (rowIndex: number, colIndex: number) => void;
}

/// Column-scoped selection: a vertical range of rows within a single column. `col` is
/// fixed to the column the selection started in; shift/ctrl extend within it. Only the
/// cells in `col` are highlighted (not whole rows), and Ctrl+C copies those cells.
interface Sel {
  rows: Set<number>;
  anchor: number;
  col: number;
}

export function ResultGrid({
  columns,
  rows,
  hasMore,
  fetchingMore,
  capped,
  fetchedTotal,
  estimatedTotal,
  elapsedMs,
  onFetchMore,
  onCellActivate,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  // `up`: the footer "Copy ▾" menu is anchored to the button and opens UPWARD; the
  // right-click menu opens downward at the cursor (no `up`).
  const [menu, setMenu] = useState<{ x: number; y: number; up?: boolean } | null>(null);
  // Column widths: session-only, NOT persisted. Empty = the default COL_W. Reset on a
  // new query (the [columns] effect below). estimateSize reads from here; when it
  // changes, colV.measure() refreshes the offsets.
  const [colWidths, setColWidths] = useState<number[]>([]);

  // New query (columns reference changed) → reset selection + menu + column widths.
  // Paging (fetchMore) doesn't change columns, so these persist across pages.
  useEffect(() => {
    setSel(null);
    setMenu(null);
    setColWidths([]);
  }, [columns]);

  const rowV = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  const colV = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => colWidths[i] ?? COL_W,
    overscan: 3,
  });
  // When a column width changes, refresh the virtualizer's offset/size cache
  // (otherwise the header widens but the body alignment stays stale).
  useEffect(() => {
    colV.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colWidths]);

  const startColResize = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[index] ?? COL_W;
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(48, startW + (ev.clientX - startX));
      setColWidths((prev) => {
        const out = prev.slice();
        for (let k = out.length; k < index; k++) out[k] = COL_W;
        out[index] = next;
        return out;
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = prevSelect;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Infinite scroll: fetch the next page as we approach the end.
  const virtualRows = rowV.getVirtualItems();
  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (last && last.index >= rows.length - 30 && hasMore && !fetchingMore) {
      onFetchMore();
    }
  }, [virtualRows, rows.length, hasMore, fetchingMore, onFetchMore]);

  const cols = colV.getVirtualItems();

  const clickCell = (e: React.MouseEvent, r: number, c: number) => {
    setSel((prev) => {
      // Shift/Ctrl keep the selection scoped to the column it started in (prev.col) so
      // the highlight stays a single vertical strip; a plain click (re)sets the column.
      if (e.shiftKey && prev) {
        const lo = Math.min(prev.anchor, r);
        const hi = Math.max(prev.anchor, r);
        const set = new Set<number>();
        for (let i = lo; i <= hi; i++) set.add(i);
        return { rows: set, anchor: prev.anchor, col: prev.col };
      }
      if ((e.ctrlKey || e.metaKey) && prev) {
        const set = new Set(prev.rows);
        if (set.has(r)) set.delete(r);
        else set.add(r);
        return { rows: set, anchor: r, col: prev.col };
      }
      return { rows: new Set([r]), anchor: r, col: c };
    });
  };

  // Ctrl/Cmd+C copies the selected column's cells (newline-joined), matching the
  // single-column selection. The grid container is focusable so it receives the key.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
      if (!sel || sel.rows.size === 0) return;
      e.preventDefault();
      const sorted = [...sel.rows].sort((a, b) => a - b);
      const text = sorted.map((i) => rows[i]?.[sel.col] ?? "").join("\n");
      void copyText(text, `${sorted.length} cell${sorted.length > 1 ? "s" : ""} copied`);
    }
  };

  const openContextMenu = (e: React.MouseEvent) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!cell) return; // header/empty space: let the browser menu stay
    e.preventDefault();
    const r = Number(cell.dataset.row);
    const c = Number(cell.dataset.col);
    // Right-click outside the selection narrows it to that cell; inside, it keeps the selection.
    setSel((prev) => (prev && prev.rows.has(r) ? { ...prev, col: c } : { rows: new Set([r]), anchor: r, col: c }));
    setMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <div className="flex h-full flex-col">
      {capped && (
        <div className="border-b border-warn/40 bg-warn/10 px-3 py-1 text-[11px] text-warn">
          Showing first {MAX_LABEL} rows — add a filter to narrow results.
        </div>
      )}
      <div
        ref={parentRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="relative min-h-0 flex-1 select-none overflow-auto outline-none"
        onContextMenu={openContextMenu}
      >
        <div
          style={{ width: colV.getTotalSize(), height: rowV.getTotalSize() + ROW_H }}
          className="relative"
        >
          {/* Header (sticky) */}
          <div
            className="sticky top-0 z-10 border-b border-border bg-bg-elev"
            style={{ height: ROW_H, width: colV.getTotalSize() }}
          >
            {cols.map((c) => {
              const col = columns[c.index];
              return (
                <div
                  key={c.index}
                  className="absolute flex h-full items-center gap-1 border-r border-border px-2 font-mono text-[11px] font-medium"
                  style={{ left: c.start, width: c.size }}
                  title={`${col.name} · ${col.type_name}`}
                >
                  <span className="truncate">{col.name}</span>
                  <span className="truncate text-fg-muted">{col.type_name}</span>
                  {/* Right-edge drag handle */}
                  <div
                    onMouseDown={(e) => startColResize(e, c.index)}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-fg-muted/60"
                  />
                </div>
              );
            })}
          </div>

          {/* Body */}
          {virtualRows.map((vr) => {
            const row = rows[vr.index];
            return (
              <div
                key={vr.index}
                className={cn("absolute", vr.index % 2 === 1 && "bg-bg-elev/40")}
                style={{ top: vr.start + ROW_H, height: vr.size, width: colV.getTotalSize() }}
              >
                {cols.map((c) => {
                  const v = row[c.index];
                  // Only cells in the selected column light up (column-scoped selection).
                  const selected = sel?.col === c.index && (sel?.rows.has(vr.index) ?? false);
                  const focused = sel?.anchor === vr.index && sel?.col === c.index;
                  return (
                    <div
                      key={c.index}
                      data-cell
                      data-row={vr.index}
                      data-col={c.index}
                      onClick={(e) => clickCell(e, vr.index, c.index)}
                      onDoubleClick={() => onCellActivate?.(vr.index, c.index)}
                      className={cn(
                        "absolute flex h-full cursor-default items-center truncate border-r border-b border-border/50 px-2 font-mono text-[11px]",
                        selected && "bg-fg/20",
                        focused && "ring-1 ring-inset ring-fg-muted",
                      )}
                      style={{ left: c.start, width: c.size }}
                      title={v ?? "NULL"}
                    >
                      {v === null ? (
                        <span className="italic text-fg-muted">NULL</span>
                      ) : (
                        <span className="truncate">{v}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-2 text-[11px] text-fg-muted">
        <span>
          {fetchedTotal.toLocaleString()} rows
          {estimatedTotal && estimatedTotal > fetchedTotal ? ` (~${fmt(estimatedTotal)} total)` : ""}
          {hasMore ? " · scroll for more" : ""}
        </span>
        <span>{elapsedMs} ms</span>
        {fetchingMore && <span>loading…</span>}
        <button
          className="ml-auto hover:text-fg"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            // Anchor the menu to the button's TOP edge so it grows upward.
            setMenu({ x: r.right, y: r.top, up: true });
          }}
          title="Copy…"
        >
          Copy ▾
        </button>
      </div>

      {menu && (
        <CopyMenu
          x={menu.x}
          y={menu.y}
          up={menu.up}
          columns={columns}
          rows={rows}
          sel={sel}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/// The copy menu: opened from a right-clicked cell or the footer "Copy ▾". If opened
/// via right-click, `sel` carries the focused cell + selected rows; from the footer,
/// sel may be null → only the "all rows" items are meaningful.
function CopyMenu({
  x,
  y,
  up,
  columns,
  rows,
  sel,
  onClose,
}: {
  x: number;
  y: number;
  up?: boolean;
  columns: ColumnMeta[];
  rows: (string | null)[][];
  sel: Sel | null;
  onClose: () => void;
}) {
  const headers = columns.map((c) => c.name);
  const selRows = sel && sel.rows.size > 0 ? [...sel.rows].sort((a, b) => a - b) : null;
  const targetRows = selRows ?? rows.map((_, i) => i); // no selection → all rows
  const targetMatrix = targetRows.map((i) => rows[i]);
  const rowsLabel = selRows ? `${selRows.length} row${selRows.length > 1 ? "s" : ""}` : "all rows";
  const heavy = targetRows.length > HEAVY_FORMAT_LIMIT;
  const focusCol = sel?.col ?? null;

  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-40"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="absolute w-56 rounded-md border border-border bg-bg-elev p-1 text-xs shadow-2xl"
        // Footer (up): pin the bottom-right corner to the button's top-right → the menu
        // grows up/left, no need to know its height. Right-click: downward from the cursor.
        style={
          up
            ? { right: window.innerWidth - x, bottom: window.innerHeight - y + 4 }
            : { left: Math.min(x, window.innerWidth - 236), top: Math.min(y, window.innerHeight - 320) }
        }
        onClick={(e) => e.stopPropagation()}
      >
        {sel && focusCol != null && (
          <>
            <Item
              onClick={() =>
                run(() => void copyText(rows[sel.anchor]?.[focusCol] ?? "", "Cell copied"))
              }
            >
              Copy cell
            </Item>
            <Sep />
          </>
        )}

        <Item onClick={() => run(() => void copyText(toDelimited(headers, targetMatrix, ","), `${rowsLabel} copied (CSV)`))}>
          Copy {rowsLabel} as CSV
        </Item>
        <Item onClick={() => run(() => void copyText(toDelimited(headers, targetMatrix, "\t"), `${rowsLabel} copied (TSV)`))}>
          Copy {rowsLabel} as TSV
        </Item>
        <Item
          disabled={heavy}
          hint={heavy ? "use CSV for large results" : undefined}
          onClick={() => run(() => void copyText(toJson(headers, targetMatrix), `${rowsLabel} copied (JSON)`))}
        >
          Copy {rowsLabel} as JSON
        </Item>
        <Item
          disabled={heavy}
          hint={heavy ? "use CSV for large results" : undefined}
          onClick={() => run(() => void copyText(toMarkdown(headers, targetMatrix), `${rowsLabel} copied (Markdown)`))}
        >
          Copy {rowsLabel} as Markdown
        </Item>

        {focusCol != null && (
          <>
            <Sep />
            <Item
              onClick={() =>
                run(() =>
                  void copyText(
                    rows.map((r) => r[focusCol] ?? "").join("\n"),
                    `Column "${headers[focusCol]}" copied`,
                  ),
                )
              }
            >
              Copy column values
            </Item>
            <Item onClick={() => run(() => void copyText(headers[focusCol], "Column name copied"))}>
              Copy column name
            </Item>
          </>
        )}
        <Sep />
        <Item onClick={() => run(() => void copyText(headers.join(", "), "All column names copied"))}>
          Copy all column names
        </Item>
        <div className="px-2 py-1 text-[10px] text-fg-muted">fetched rows only</div>
      </div>
    </div>
  );
}

function Item({
  children,
  onClick,
  disabled,
  hint,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={hint}
      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left outline-none hover:bg-bg disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div className="my-1 h-px bg-border" />;
}

const MAX_LABEL = (100_000).toLocaleString();

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
