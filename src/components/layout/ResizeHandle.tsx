import { useRef } from "react";

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
    const onMove = (ev: MouseEvent) => onResize(startW.current + (ev.clientX - startX.current));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return (
    <div
      onMouseDown={onDown}
      className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-border"
    />
  );
}
