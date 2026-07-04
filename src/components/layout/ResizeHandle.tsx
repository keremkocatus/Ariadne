import { useRef } from "react";

/// Sürükleme boyunca metin seçimini engelle (aksi halde imleç metni seçer).
function withDragGuard(onMove: (ev: MouseEvent) => void) {
  const prevSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = prevSelect;
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/// Sidebar genişliğini sürükleyerek ayarlayan ince tutamak (design 07 §2).
export function ResizeHandle({
  width,
  onResize,
}: {
  width: number;
  onResize: (w: number) => void;
}) {
  const startX = useRef(0);
  const startW = useRef(0);
  const onDown = (e: React.MouseEvent) => {
    startX.current = e.clientX;
    startW.current = width;
    withDragGuard((ev) => onResize(startW.current + (ev.clientX - startX.current)));
  };
  // Hit alanı geniş (8px, kolay yakalanır) ama görsel çizgi ince (2px); hover'da
  // belirginleşir (design 20 M2 — keşfedilebilirlik + kavranabilirlik).
  return (
    <div
      onMouseDown={onDown}
      className="group flex w-2 shrink-0 cursor-col-resize justify-center bg-transparent"
    >
      <div className="h-full w-0.5 bg-border/60 transition-colors group-hover:bg-fg-muted" />
    </div>
  );
}

/// Sonuç panelinin yüksekliğini ayarlayan yatay tutamak (design 19 §P1-X3 N7).
/// Editör üstte, sonuç altta; tutamağı YUKARI sürüklemek sonucu büyütür. Yükseklik
/// [80, ana-alan − 160] aralığına kısılır (editöre yer kalsın). Monaco automaticLayout
/// açık olduğundan editör yeniden boyutlandığında kendini relayout eder.
export function HResizeHandle({
  height,
  onResize,
}: {
  height: number;
  onResize: (h: number) => void;
}) {
  const startY = useRef(0);
  const startH = useRef(0);
  const onDown = (e: React.MouseEvent) => {
    startY.current = e.clientY;
    startH.current = height;
    const main = (e.currentTarget as HTMLElement).closest("main");
    const maxH = main ? Math.max(80, main.clientHeight - 160) : Infinity;
    withDragGuard((ev) => {
      const next = startH.current + (startY.current - ev.clientY);
      onResize(Math.max(80, Math.min(next, maxH)));
    });
  };
  return (
    <div
      onMouseDown={onDown}
      className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-border"
    />
  );
}
