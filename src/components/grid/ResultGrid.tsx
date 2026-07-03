import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ColumnMeta } from "@/lib/api";

const ROW_H = 24;
const COL_W = 168;

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

  return (
    <div className="flex h-full flex-col">
      {capped && (
        <div className="border-b border-warn/40 bg-warn/10 px-3 py-1 text-[11px] text-warn">
          Showing first {MAX_LABEL} rows — add a filter to narrow results.
        </div>
      )}
      <div ref={parentRef} className="relative min-h-0 flex-1 overflow-auto">
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
            return (
              <div
                key={vr.index}
                className={cn("absolute", vr.index % 2 === 1 && "bg-bg-elev/40")}
                style={{ top: vr.start + ROW_H, height: vr.size, width: colV.getTotalSize() }}
              >
                {cols.map((c) => {
                  const v = row[c.index];
                  return (
                    <div
                      key={c.index}
                      className="absolute flex h-full items-center truncate border-r border-b border-border/50 px-2 font-mono text-[11px]"
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
        <div className="ml-auto flex gap-2">
          <button className="hover:text-fg" onClick={() => copy(columns, rows, ",")}>
            Copy CSV
          </button>
          <button className="hover:text-fg" onClick={() => copy(columns, rows, "\t")}>
            Copy TSV
          </button>
        </div>
      </div>
    </div>
  );
}

const MAX_LABEL = (100_000).toLocaleString();

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function copy(columns: ColumnMeta[], rows: (string | null)[][], sep: string) {
  const esc = (v: string | null) => {
    if (v === null) return "";
    if (sep === "," && /[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  const header = columns.map((c) => c.name).join(sep);
  const body = rows.map((r) => r.map(esc).join(sep)).join("\n");
  void navigator.clipboard
    .writeText(`${header}\n${body}`)
    .then(() => toast.success(`${rows.length} rows copied`))
    .catch(() => toast.error("Copy failed"));
}
