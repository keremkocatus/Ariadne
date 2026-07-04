import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import { toDelimited, toJson, toMarkdown, copyText } from "@/lib/clipboard";
import type { ColumnMeta } from "@/lib/api";

const ROW_H = 24;
const COL_W = 168;
// Bu satır sayısının üstünde JSON/Markdown üretimi UI thread'ini kilitleyebilir
// (design 17 §P1-V2); o kalemler devre dışı bırakılır, CSV/TSV yolu açık kalır.
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
}

/// Satır-granülü seçim (design 17 §P1-V2): seçili satırlar + odak hücre (kolon).
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
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  // `up`: footer "Copy ▾" menüsü butona tutturulup YUKARI açılır (design 19 N6);
  // sağ-tık menüsü imleç konumunda aşağı açılır (up yok).
  const [menu, setMenu] = useState<{ x: number; y: number; up?: boolean } | null>(null);

  // Yeni sorgu (kolon referansı değişti) → seçim + menü sıfırlanır. Sayfa ekleme
  // (fetchMore) kolonları değiştirmez, bu yüzden seçim sayfalar arası korunur.
  useEffect(() => {
    setSel(null);
    setMenu(null);
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
    estimateSize: () => COL_W,
    overscan: 3,
  });

  // Sonsuz scroll: sona yaklaşınca sonraki sayfayı çek (design 05 §2).
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
      if (e.shiftKey && prev) {
        const lo = Math.min(prev.anchor, r);
        const hi = Math.max(prev.anchor, r);
        const set = new Set<number>();
        for (let i = lo; i <= hi; i++) set.add(i);
        return { rows: set, anchor: prev.anchor, col: c };
      }
      if ((e.ctrlKey || e.metaKey) && prev) {
        const set = new Set(prev.rows);
        if (set.has(r)) set.delete(r);
        else set.add(r);
        return { rows: set, anchor: r, col: c };
      }
      return { rows: new Set([r]), anchor: r, col: c };
    });
  };

  const openContextMenu = (e: React.MouseEvent) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!cell) return; // header/boşluk: tarayıcı menüsü kalsın
    e.preventDefault();
    const r = Number(cell.dataset.row);
    const c = Number(cell.dataset.col);
    // Seçim dışına sağ-tık seçimi o hücreye daraltır; içine sağ-tık seçimi korur.
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
        className="relative min-h-0 flex-1 overflow-auto"
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
                  className="absolute flex h-full items-center gap-1 truncate border-r border-border px-2 font-mono text-[11px] font-medium"
                  style={{ left: c.start, width: c.size }}
                  title={`${col.name} · ${col.type_name}`}
                >
                  <span className="truncate">{col.name}</span>
                  <span className="truncate text-fg-muted">{col.type_name}</span>
                </div>
              );
            })}
          </div>

          {/* Body */}
          {virtualRows.map((vr) => {
            const row = rows[vr.index];
            const rowSelected = sel?.rows.has(vr.index) ?? false;
            return (
              <div
                key={vr.index}
                className={cn(
                  "absolute",
                  rowSelected ? "bg-fg/10" : vr.index % 2 === 1 && "bg-bg-elev/40",
                )}
                style={{ top: vr.start + ROW_H, height: vr.size, width: colV.getTotalSize() }}
              >
                {cols.map((c) => {
                  const v = row[c.index];
                  const focused = sel?.anchor === vr.index && sel?.col === c.index;
                  return (
                    <div
                      key={c.index}
                      data-cell
                      data-row={vr.index}
                      data-col={c.index}
                      onClick={(e) => clickCell(e, vr.index, c.index)}
                      className={cn(
                        "absolute flex h-full cursor-default items-center truncate border-r border-b border-border/50 px-2 font-mono text-[11px]",
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
            // Menüyü butonun ÜST kenarına tuttur, yukarı doğru büyüsün (N6).
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

/// Kopyalama menüsü: sağ-tık hücresinden ya da footer "Copy ▾"den açılır. Sağ-tık
/// açıldıysa `sel` odak hücre + seçili satırları taşır; footer'dan açıldıysa sel
/// null olabilir → yalnız "tüm satır" kalemleri anlamlı olur (design 17 §P1-V2).
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
  const targetRows = selRows ?? rows.map((_, i) => i); // seçim yoksa tüm satırlar
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
        // Footer (up): sağ-alt köşeyi butonun sağ-üstüne sabitle → menü yukarı/sola
        // doğru büyür, yükseklik bilmeye gerek yok. Sağ-tık: imleç konumundan aşağı.
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
