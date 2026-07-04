import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { updateCell, isAriadneError, type ColumnMeta } from "@/lib/api";
import { errorTitle } from "@/lib/errors";
import { resolvePrimaryKey, buildEditability, type Editability } from "@/lib/cellEdit";

export interface CellEditContext {
  connectionId: string;
  sourceTable: { schema: string; name: string } | null;
  readOnly: boolean;
  columns: ColumnMeta[];
  row: (string | null)[];
  rowIndex: number;
  colIndex: number;
}

/// Hücre görüntüleme/düzenleme popup'ı (design 19 §P1-X4 N8). Her hücrede TAM değeri
/// gösterir (görüntüleyici, her zaman güvenli). Düzenleme yalnız tab bir tablodan
/// açıldıysa + PK çözülürse + PK değerleri satırda varsa açılır (buildEditability);
/// aksi halde salt-okunur bir not gösterilir. UPDATE tam-1-satır guard'lı (backend).
export function CellDialog({
  ctx,
  onClose,
  onSaved,
}: {
  ctx: CellEditContext;
  onClose: () => void;
  onSaved: (rowIndex: number, colIndex: number, value: string | null) => void;
}) {
  const col = ctx.columns[ctx.colIndex];
  const original = ctx.row[ctx.colIndex];

  // Düzenlenebilirlik: "resolving" → PK çözülürken; sonra editable | {reason}.
  const [edit, setEdit] = useState<Editability | { editable: "resolving" }>({
    editable: "resolving",
  });
  const [text, setText] = useState(original ?? "");
  const [isNull, setIsNull] = useState(original === null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { sourceTable, readOnly, connectionId, columns, row } = ctx;
  useEffect(() => {
    let cancelled = false;
    if (!sourceTable) {
      setEdit({ editable: false, reason: "read-only — not a single-table result" });
      return;
    }
    if (readOnly) {
      setEdit({ editable: false, reason: "read-only connection profile" });
      return;
    }
    resolvePrimaryKey(connectionId, sourceTable.schema, sourceTable.name)
      .then((pkCols) => {
        if (!cancelled) setEdit(buildEditability(pkCols, columns, row));
      })
      .catch(() => {
        if (!cancelled) setEdit({ editable: false, reason: "read-only — couldn't resolve primary key" });
      });
    return () => {
      cancelled = true;
    };
    // Stabil alanlara bağlı (ctx objesi her render'da yeni; alanlar q'dan stabil ref).
  }, [connectionId, sourceTable, readOnly, columns, row]);

  const canEdit = edit.editable === true;
  const pretty = prettyJson(original);

  const save = async () => {
    if (!canEdit || !ctx.sourceTable) return;
    const newValue = isNull ? null : text;
    if (newValue === original) {
      onClose(); // değişiklik yok
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateCell({
        connectionId: ctx.connectionId,
        schema: ctx.sourceTable.schema,
        table: ctx.sourceTable.name,
        pk: (edit as Extract<Editability, { editable: true }>).pk,
        column: col.name,
        newValue,
      });
      onSaved(ctx.rowIndex, ctx.colIndex, newValue);
      toast.success(`Updated ${col.name}`);
      onClose();
    } catch (e) {
      setError(isAriadneError(e) ? `${errorTitle(e)}: ${e.message}` : String(e));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="w-[560px]">
        <DialogTitle className="pr-6">
          <span className="font-mono">{col.name}</span>
          <span className="ml-2 text-[11px] font-normal text-fg-muted">{col.type_name}</span>
        </DialogTitle>

        {canEdit ? (
          <div className="mt-3 space-y-2">
            <textarea
              value={isNull ? "" : text}
              disabled={isNull || saving}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              className="h-52 w-full resize-y rounded border border-border bg-bg p-2 font-mono text-xs outline-none focus:border-fg-muted disabled:opacity-50"
              autoFocus
            />
            <label className="flex items-center gap-1.5 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={isNull}
                disabled={saving}
                onChange={(e) => setIsNull(e.target.checked)}
              />
              Set NULL
            </label>
            {error && (
              <p className="whitespace-pre-wrap rounded border border-danger/30 bg-danger/5 p-2 font-mono text-[11px] text-danger">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                disabled={saving}
                className="rounded border border-border px-3 py-1 text-xs hover:border-fg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void save()}
                disabled={saving}
                className="rounded border border-fg bg-fg px-3 py-1 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <ReadOnlyValue value={original} pretty={pretty} />
            <p className="text-[11px] text-fg-muted">
              {edit.editable === "resolving" ? "Checking if editable…" : edit.reason}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReadOnlyValue({ value, pretty }: { value: string | null; pretty: string | null }) {
  if (value === null) {
    return <div className="rounded border border-border bg-bg p-2 font-mono text-xs italic text-fg-muted">NULL</div>;
  }
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg p-2 font-mono text-xs">
      {pretty ?? value}
    </pre>
  );
}

/// JSON gibi görünen değeri güzel bas (obje/dizi); değilse null (ham gösterilir).
function prettyJson(value: string | null): string | null {
  if (value === null) return null;
  const t = value.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return null;
  }
}
