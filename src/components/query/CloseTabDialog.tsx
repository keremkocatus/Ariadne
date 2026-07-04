import { AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Commit / Rollback / Cancel confirmation when closing a tab with an open transaction.
export function CloseTabDialog({
  onCommit,
  onRollback,
  onCancel,
}: {
  onCommit: () => void;
  onRollback: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="w-[400px]">
        <DialogTitle className="flex items-center gap-2 text-warn">
          <AlertTriangle size={15} /> Open transaction
        </DialogTitle>
        <p className="mt-2 text-xs text-fg">
          This tab has an open transaction. Commit or roll back before closing?
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onRollback}>
            Rollback &amp; close
          </Button>
          <Button variant="default" onClick={onCommit}>
            Commit &amp; close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
