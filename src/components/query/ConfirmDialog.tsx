import { AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { Confirmation } from "@/lib/api";

// Destructive guard modal (design 05 §8, 07 §3). "Bu oturumda sorma" YOK — pazarlıksız.
export function ConfirmDialog({
  conf,
  onConfirm,
  onCancel,
}: {
  conf: Confirmation;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="w-[400px]">
        <DialogTitle className="flex items-center gap-2 text-danger">
          <AlertTriangle size={15} /> Destructive statement
        </DialogTitle>
        <p className="mt-2 text-xs text-fg">
          <span className="font-mono uppercase">{conf.kind}</span> without a WHERE clause on{" "}
          <span className="font-mono font-semibold">{conf.table}</span>
          {conf.estimated_rows != null ? ` — ~${conf.estimated_rows.toLocaleString()} rows affected` : ""}.
        </p>
        <p className="mt-1 text-[11px] text-fg-muted">
          Statements before this one in the script have already run.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm}>
            Run anyway
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
