// A small positioned action menu — the app's context menu. Used by the Explorer
// (context bar, schema and object nodes), the roles list and the tab strip. A
// hand-rolled overlay, the same pattern as FilterPopover/CopyMenu: the caller owns
// the open state and the coordinates.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface QuickAction {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  /** Right-aligned secondary text, e.g. a shortcut. */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
}

/// `"separator"` draws a divider between groups of actions.
export type QuickMenuItem = QuickAction | "separator";

export function QuickActionMenu({
  x,
  y,
  actions,
  onClose,
}: {
  x: number;
  y: number;
  actions: QuickMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Positioned after the first layout so the menu's real size keeps it on screen.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

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
        ref={ref}
        role="menu"
        className={cn(
          "ari-menu-in absolute min-w-44 rounded-lg border border-border bg-bg-elev p-1 text-xs shadow-2xl",
          !pos && "invisible",
        )}
        style={pos ?? { left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        {actions.map((a, i) =>
          a === "separator" ? (
            <div key={`sep-${i}`} className="my-1 h-px bg-border" />
          ) : (
            <button
              key={a.label}
              role="menuitem"
              disabled={a.disabled}
              onClick={() => {
                a.onClick();
                onClose();
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left outline-none transition-colors",
                "hover:bg-bg-hover disabled:pointer-events-none disabled:opacity-40",
                a.danger && "text-danger hover:bg-danger/10",
              )}
            >
              {a.icon && <span className="flex w-3.5 shrink-0 justify-center text-fg-muted">{a.icon}</span>}
              <span className="flex-1 truncate">{a.label}</span>
              {a.hint && <span className="shrink-0 pl-3 text-[10px] text-fg-subtle">{a.hint}</span>}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
