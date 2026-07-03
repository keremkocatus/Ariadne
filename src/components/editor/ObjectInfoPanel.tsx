import { KeyRound, X } from "lucide-react";
import type { ObjectInfo } from "@/lib/api";

// Alt+F1 peek paneli (design 07 §3). Cache'ten gelen kolon/PK/FK bilgisi.
export function ObjectInfoPanel({ info, onClose }: { info: ObjectInfo; onClose: () => void }) {
  return (
    <div className="absolute right-3 top-3 z-20 max-h-[70%] w-[340px] overflow-auto rounded-md border border-border bg-bg-elev p-3 text-xs shadow-2xl">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium">
          {info.schema}.{info.name}
          <span className="ml-2 text-[10px] text-fg-muted">{info.kind}</span>
        </span>
        <button className="text-fg-muted hover:text-fg" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      {info.estimated_rows > 0 && (
        <div className="mb-1 text-[10px] text-fg-muted">~{info.estimated_rows.toLocaleString()} rows</div>
      )}
      {info.comment && <p className="mb-2 text-[11px] text-fg-muted">{info.comment}</p>}

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

      {info.foreign_keys.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-muted">Foreign keys</div>
          {info.foreign_keys.map((fk) => (
            <div key={fk.constraint_name} className="font-mono text-[11px] text-fg-muted">
              {fk.columns.join(", ")} → {fk.ref_table}({fk.ref_columns.join(", ")})
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
