// Explorer alt paneli: bir ilişkinin kolonları (design 07 §2 "peek columns").
import type { SnapRel } from "@/lib/api";

export function PeekPanel({ rel, onClose }: { rel: SnapRel; onClose: () => void }) {
  return (
    <div className="max-h-[38%] overflow-auto border-t border-border bg-bg-elev p-2 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium">{rel.name}</span>
        <button className="text-fg-muted hover:text-fg" onClick={onClose}>
          ×
        </button>
      </div>
      {rel.comment && <p className="mb-1 text-[11px] text-fg-muted">{rel.comment}</p>}
      <table className="w-full">
        <tbody>
          {rel.columns.map((c) => (
            <tr key={c.name}>
              <td className="pr-2 font-mono">{c.name}</td>
              <td className="text-fg-muted">{c.type_name}</td>
              <td className="pl-1 text-[10px] text-fg-muted">{c.not_null ? "not null" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
