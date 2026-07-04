import { ArrowLeft, KeyRound } from "lucide-react";
import type { ObjectInfo } from "@/lib/api";

// Alt+F1 object info — no longer a floating panel but an overlay in the results area
// (sp_help-style). Closed with "× back to results"; the query result underneath isn't
// overwritten and returns.
export function ObjectInfoView({ info, onClose }: { info: ObjectInfo; onClose: () => void }) {
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
        {info.estimated_rows > 0 && (
          <div className="mb-1 text-[10px] text-fg-muted">~{info.estimated_rows.toLocaleString()} rows</div>
        )}
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
