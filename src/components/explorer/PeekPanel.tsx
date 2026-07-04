// Explorer alt paneli: bir ilişkinin kolonları (cache'ten anında) + indeks/trigger
// /boyut (on-demand lazy yüklenir) — design 07 §2 + design 15 §P1-U3.
import { useEffect, useMemo, useState } from "react";
import { getRelationDetails, type RelationDetails, type SnapRel } from "@/lib/api";

interface Props {
  schema: string;
  rel: SnapRel;
  connectionId: string | null;
  onClose: () => void;
}

// Bu sayının üstünde kolonda arama kutusu gösterilir (client-side filtre — veri elimizde).
const COLUMN_FILTER_THRESHOLD = 40;

export function PeekPanel({ schema, rel, connectionId, onClose }: Props) {
  const [details, setDetails] = useState<RelationDetails | null>(null);
  const [detailErr, setDetailErr] = useState(false);
  const [colFilter, setColFilter] = useState("");

  // schema.name değişince detayları yeniden çek (peek başka tabloya geçince).
  useEffect(() => {
    setDetails(null);
    setDetailErr(false);
    setColFilter("");
    if (!connectionId) return;
    let cancelled = false;
    getRelationDetails(connectionId, schema, rel.name)
      .then((d) => !cancelled && setDetails(d))
      .catch(() => !cancelled && setDetailErr(true));
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema, rel.name]);

  const cols = useMemo(() => {
    const q = colFilter.trim().toLowerCase();
    return q ? rel.columns.filter((c) => c.name.toLowerCase().includes(q)) : rel.columns;
  }, [rel.columns, colFilter]);

  return (
    <div className="flex max-h-[42%] flex-col overflow-hidden border-t border-border bg-bg-elev text-xs">
      <div className="flex shrink-0 items-center justify-between px-2 py-1">
        <span className="truncate font-medium">
          {rel.name}
          <span className="ml-2 text-[10px] text-fg-muted">{rel.kind}</span>
        </span>
        <button className="text-fg-muted hover:text-fg" onClick={onClose}>
          ×
        </button>
      </div>
      {rel.comment && <p className="shrink-0 px-2 pb-1 text-[11px] text-fg-muted">{rel.comment}</p>}

      {/* Boyut + satır (yüklenince) */}
      {details && (
        <div className="shrink-0 px-2 pb-1 text-[10px] text-fg-muted">
          {formatBytes(details.size_bytes)}
          {details.live_rows >= 0 && ` · ~${details.live_rows.toLocaleString()} rows`}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {/* Kolonlar — cache'ten anında */}
        <Section title={`Columns (${rel.columns.length})`} defaultOpen>
          {rel.columns.length > COLUMN_FILTER_THRESHOLD && (
            <input
              value={colFilter}
              onChange={(e) => setColFilter(e.target.value)}
              placeholder="Filter columns…"
              className="mb-1 w-full rounded border border-border bg-bg px-1.5 py-0.5 text-xs outline-none focus:border-fg-muted"
            />
          )}
          <table className="w-full">
            <tbody>
              {cols.map((c) => (
                <tr key={c.name}>
                  <td className="py-0.5 pr-2 font-mono">{c.name}</td>
                  <td className="text-fg-muted">{c.type_name}</td>
                  <td className="pl-1 text-[10px] text-fg-muted">{c.not_null ? "not null" : ""}</td>
                </tr>
              ))}
              {cols.length === 0 && (
                <tr>
                  <td className="py-0.5 text-fg-muted">No matching columns</td>
                </tr>
              )}
            </tbody>
          </table>
        </Section>

        {/* Indexes — lazy */}
        <Section title={`Indexes${details ? ` (${details.indexes.length})` : ""}`}>
          {detailErr ? (
            <p className="text-danger">Couldn't load</p>
          ) : !details ? (
            <p className="text-fg-muted">Loading…</p>
          ) : details.indexes.length === 0 ? (
            <p className="text-fg-muted">None</p>
          ) : (
            details.indexes.map((ix) => (
              <div key={ix.name} className="mb-1">
                <div className="font-mono">
                  {ix.name}
                  {ix.is_primary && <span className="ml-1 text-[10px] text-warn">PK</span>}
                  {ix.is_unique && !ix.is_primary && (
                    <span className="ml-1 text-[10px] text-fg-muted">unique</span>
                  )}
                </div>
                <div className="whitespace-pre-wrap break-all font-mono text-[10px] text-fg-muted">
                  {ix.definition}
                </div>
              </div>
            ))
          )}
        </Section>

        {/* Triggers — lazy */}
        <Section title={`Triggers${details ? ` (${details.triggers.length})` : ""}`}>
          {detailErr ? (
            <p className="text-danger">Couldn't load</p>
          ) : !details ? (
            <p className="text-fg-muted">Loading…</p>
          ) : details.triggers.length === 0 ? (
            <p className="text-fg-muted">None</p>
          ) : (
            details.triggers.map((tg) => (
              <div key={tg.name} className="mb-1 font-mono">
                <div>{tg.name}</div>
                <div className="text-[10px] text-fg-muted">
                  {tg.timing} {tg.events} → {tg.function}()
                </div>
              </div>
            ))
          )}
        </Section>
      </div>
    </div>
  );
}

/// Katlanabilir bölüm (accordion). Başlık sticky kalır.
function Section({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="border-t border-border/60 first:border-t-0">
      <summary className="sticky top-0 cursor-pointer select-none bg-bg-elev py-1 text-[10px] uppercase tracking-wide text-fg-muted">
        {title}
      </summary>
      <div className="pb-1">{children}</div>
    </details>
  );
}

function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
