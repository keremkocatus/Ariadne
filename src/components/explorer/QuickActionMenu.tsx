// Konumlandırılmış küçük eylem menüsü (design 18 §P1-W3). Explorer bağlam çubuğu
// ve şema düğümü sağ-tıkı bunu kullanır — FilterPopover/CopyMenu ile aynı
// hand-rolled overlay deseni (Radix context-menu yerine, kod tutarlılığı için).
export interface QuickAction {
  label: string;
  onClick: () => void;
}

export function QuickActionMenu({
  x,
  y,
  actions,
  onClose,
}: {
  x: number;
  y: number;
  actions: QuickAction[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="absolute w-48 rounded-md border border-border bg-bg-elev p-1 text-xs shadow-2xl"
        style={{ left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - 120) }}
        onClick={(e) => e.stopPropagation()}
      >
        {actions.map((a) => (
          <button
            key={a.label}
            onClick={() => {
              a.onClick();
              onClose();
            }}
            className="flex w-full items-center rounded px-2 py-1 text-left outline-none hover:bg-bg"
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
