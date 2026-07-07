import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { updateCell, isAriadneError, type ColumnMeta } from "@/lib/api";
import { errorTitle } from "@/lib/errors";
import {
  resolvePrimaryKey,
  buildEditability,
  isTruncatedCell,
  type Editability,
} from "@/lib/cellEdit";

export interface CellEditContext {
  connectionId: string;
  sourceTable: { schema: string; name: string } | null;
  readOnly: boolean;
  columns: ColumnMeta[];
  row: (string | null)[];
  rowIndex: number;
  colIndex: number;
}

/// The cell view/edit popup. Shows the FULL value of any cell (a viewer, always
/// safe). Editing is enabled only when the tab was opened from a table + the PK
/// resolves + the PK values are in the row (buildEditability); otherwise it shows a
/// read-only note. The UPDATE has a single-row guard (backend).
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

  // Editability: "resolving" → while resolving the PK; then editable | {reason}.
  const [edit, setEdit] = useState<Editability | { editable: "resolving" }>({
    editable: "resolving",
  });
  const [text, setText] = useState(original ?? "");
  const [isNull, setIsNull] = useState(original === null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { sourceTable, readOnly, connectionId, columns, row, colIndex } = ctx;
  useEffect(() => {
    let cancelled = false;
    // Guard order matters: a truncated cell must never be editable — saving it would
    // overwrite the full value in the database with the truncated display text.
    if (isTruncatedCell(row[colIndex])) {
      setEdit({
        editable: false,
        reason:
          "This value was truncated for display (over 8 KB). Edit it with an UPDATE statement instead, to avoid overwriting the full value.",
      });
      return;
    }
    if (!sourceTable) {
      setEdit({
        editable: false,
        reason:
          "This result didn't come from a single table. Open the table from the sidebar to edit its rows.",
      });
      return;
    }
    if (readOnly) {
      setEdit({ editable: false, reason: "This connection profile is marked read-only." });
      return;
    }
    resolvePrimaryKey(connectionId, sourceTable.schema, sourceTable.name)
      .then((pkCols) => {
        if (!cancelled) setEdit(buildEditability(pkCols, columns, row));
      })
      .catch(() => {
        if (!cancelled)
          setEdit({ editable: false, reason: "Couldn't resolve the table's primary key." });
      });
    return () => {
      cancelled = true;
    };
    // Keyed on stable fields (the ctx object is new each render; the fields are stable refs from q).
  }, [connectionId, sourceTable, readOnly, columns, row, colIndex]);

  const canEdit = edit.editable === true;
  const pretty = prettyJson(original);

  const save = async () => {
    if (!canEdit || !ctx.sourceTable) return;
    const newValue = isNull ? null : text;
    if (newValue === original) {
      onClose(); // no change
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
      <DialogContent className="w-[560px]" hideClose={saving}>
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
              <Button onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button variant="default" onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <ReadOnlyValue value={original} pretty={pretty} />
            {edit.editable === "resolving" ? (
              <p className="text-[11px] text-fg-muted">Checking if editable…</p>
            ) : (
              <p className="rounded border border-border bg-bg px-2 py-1.5 text-[11px] text-fg-muted">
                <span className="font-medium text-fg">Read-only.</span> {edit.reason}
              </p>
            )}
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

/// Pretty-print a value that looks like JSON (object/array); otherwise null (shown raw).
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
