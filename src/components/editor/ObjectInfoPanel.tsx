import { useEffect, useState } from "react";
import { ArrowLeft, KeyRound } from "lucide-react";
import { getRelationDetails, type ObjectInfo, type RelationDetails } from "@/lib/api";
import { formatBytes } from "@/lib/format";

// Alt+F1 object info — an overlay in the results area (sp_help-style). Columns/PK/FKs
// come from the schema cache; index and size details are fetched lazily from the DB.
// Closed with "back to results"; the query result underneath isn't overwritten.
export function ObjectInfoView({
  info,
  connectionId,
  onClose,
}: {
  info: ObjectInfo;
  connectionId: string | null;
  onClose: () => void;
}) {
  const details = useRelationDetails(connectionId, info.schema, info.name);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-bg-elev/40 px-3 py-1 text-xs">
        <span className="font-medium">
          Object info · {info.schema}.{info.name}
          <span className="ml-2 text-[10px] text-fg-muted">{info.kind}</span>
        </span>
        <button
          className="flex items-center gap-1 text-fg-muted hover:text-fg"
          onClick={onClose}
          title="Back to results"
        >
          <ArrowLeft size={12} /> back to results
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
        <div className="mb-1 flex flex-wrap gap-x-3 text-[10px] text-fg-muted">
          {info.estimated_rows > 0 && <span>~{info.estimated_rows.toLocaleString()} rows</span>}
          {details != null && details.size_bytes > 0 && <span>{formatBytes(details.size_bytes)} on disk</span>}
        </div>
        {info.comment && <p className="mb-2 text-[11px] text-fg-muted">{info.comment}</p>}

        <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-muted">Columns</div>
        <table className="w-full">
          <tbody>
            {info.columns.map((c) => (
              <tr key={c.name}>
                <td className="py-0.5 pr-2 font-mono">
                  {c.is_pk && <KeyRound size={10} className="mr-1 inline text-warn" />}
                  {c.name}
                </td>
                <td className="text-fg-muted">{c.type_name}</td>
                <td className="pl-1 text-[10px] text-fg-muted">{c.not_null ? "not null" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {info.primary_key.length > 0 && (
          <div className="mt-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-muted">Primary key</div>
            <div className="font-mono text-[11px] text-fg-muted">{info.primary_key.join(", ")}</div>
          </div>
        )}

        <div className="mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-muted">Indexes</div>
          {details == null ? (
            <div className="text-[11px] text-fg-muted">Loading…</div>
          ) : details.indexes.length === 0 ? (
            <div className="text-[11px] text-fg-muted">No indexes</div>
          ) : (
            <div className="space-y-1">
              {details.indexes.map((ix) => (
                <div key={ix.name} className="font-mono text-[11px]">
                  <span className="text-fg">{ix.name}</span>
                  {ix.is_primary ? (
                    <span className="ml-1 rounded bg-warn/20 px-1 text-[9px] text-warn">PRIMARY</span>
                  ) : ix.is_unique ? (
                    <span className="ml-1 rounded bg-fg/10 px-1 text-[9px] text-fg-muted">UNIQUE</span>
                  ) : null}
                  <div className="text-[10px] text-fg-muted">{ix.definition}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {info.foreign_keys.length > 0 && (
          <div className="mt-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-muted">Foreign keys</div>
            {info.foreign_keys.map((fk) => (
              <div key={fk.constraint_name} className="font-mono text-[11px] text-fg-muted">
                {fk.columns.join(", ")} → {fk.ref_table}({fk.ref_columns.join(", ")})
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/// Fetches on-demand index/size details for the object. Returns null while loading or
/// if the fetch fails (e.g. a view with no relation details) — the panel shows the
/// cache-based columns/PK/FKs regardless.
function useRelationDetails(
  connectionId: string | null,
  schema: string,
  name: string,
): RelationDetails | null {
  const [details, setDetails] = useState<RelationDetails | null>(null);
  useEffect(() => {
    if (!connectionId) {
      setDetails(null);
      return;
    }
    let cancelled = false;
    setDetails(null);
    getRelationDetails(connectionId, schema, name)
      .then((d) => !cancelled && setDetails(d))
      .catch(() => !cancelled && setDetails({ indexes: [], triggers: [], size_bytes: 0, live_rows: 0 }));
    return () => {
      cancelled = true;
    };
  }, [connectionId, schema, name]);
  return details;
}
