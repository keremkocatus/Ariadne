import { useRef } from "react";

/// Suppress text selection during a drag (otherwise the cursor selects text).
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

/// A thin handle that adjusts the sidebar width by dragging.
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
  // Wide hit area (8px, easy to grab) but a thin (2px) visual line; brightens on
  // hover (discoverability + grabbability).
  return (
    <div
      onMouseDown={onDown}
      className="group flex w-2 shrink-0 cursor-col-resize justify-center bg-transparent"
    >
      <div className="h-full w-0.5 bg-border/60 transition-colors group-hover:bg-fg-muted" />
    </div>
  );
}

/// A horizontal handle that adjusts the results panel height. Editor on top, results
/// below; dragging the handle UP grows the results. The height is clamped to
/// [80, main height − 160] (to leave room for the editor). Since Monaco's
/// automaticLayout is on, the editor relayouts itself when resized.
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
