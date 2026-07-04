import { AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Kaydedilmemiş .sql tab'ı kapatılırken Save / Don't save / Cancel (design 15 §P1-U4).
// Açık tx onayından bağımsız ve sonra gelir (tx önce çözülür).
export function SaveTabDialog({
  fileName,
  onSave,
  onDiscard,
  onCancel,
}: {
  fileName: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="w-[400px]">
        <DialogTitle className="flex items-center gap-2 text-warn">
          <AlertTriangle size={15} /> Unsaved changes
        </DialogTitle>
        <p className="mt-2 text-xs text-fg">
          <span className="font-mono">{fileName}</span> has unsaved changes. Save before closing?
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onDiscard}>
            Don&apos;t save
          </Button>
          <Button variant="default" onClick={onSave}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
