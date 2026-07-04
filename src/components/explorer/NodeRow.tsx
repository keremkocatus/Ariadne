// react-arborist node renderer: icon + name + row estimate + pin button.
import { type NodeRendererProps } from "react-arborist";
import { ChevronRight, Pin } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRows, type TreeNode } from "./tree";
import { iconFor } from "./icons";

export function NodeRow({
  node,
  style,
  onPeek,
  onActivate,
  onPin,
  isPinned,
  onContextMenu,
  isFiltered,
  onMore,
}: NodeRendererProps<TreeNode> & {
  onPeek: (n: TreeNode) => void;
  onActivate: (n: TreeNode) => void;
  onPin: (n: TreeNode) => void;
  isPinned: (n: TreeNode) => boolean;
  onContextMenu: (n: TreeNode, e: React.MouseEvent) => void;
  isFiltered: (n: TreeNode) => boolean;
  onMore: (n: TreeNode, e: React.MouseEvent) => void;
}) {
  const d = node.data;
  // "more" node: the category cap was exceeded; click = filter popover.
  if (d.ntype === "more") {
    return (
      <div
        style={style}
        className="flex h-6 cursor-pointer items-center gap-1 pl-4 pr-1 text-[11px] italic text-fg-muted hover:text-fg"
        onClick={(e) => onMore(d, e)}
      >
        <span className="truncate">{d.name}</span>
      </div>
    );
  }
  const isLeaf = d.ntype === "relation" || d.ntype === "function";
  return (
    <div
      style={style}
      className={cn(
        "group flex h-6 cursor-pointer items-center gap-1 pr-1 text-xs hover:bg-bg-elev",
        node.isSelected && "bg-bg-elev",
      )}
      onClick={() => {
        // Single click: peek on a leaf, expand/collapse on a group.
        if (isLeaf) onPeek(d);
        else node.toggle();
      }}
      onDoubleClick={() => isLeaf && onActivate(d)}
      onContextMenu={(e) => onContextMenu(d, e)}
    >
      {!isLeaf ? (
        <ChevronRight
          size={12}
          className={cn("shrink-0 text-fg-muted transition-transform", node.isOpen && "rotate-90")}
        />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      {iconFor(d)}
      <span className="truncate">{d.name}</span>
      {d.ntype === "category" && isFiltered(d) && (
        <span className="shrink-0 rounded bg-warn/20 px-1 text-[9px] text-warn">filtered</span>
      )}
      {d.rel && d.rel.estimated_rows > 0 && (
        <span className="ml-auto shrink-0 pl-2 text-[10px] text-fg-muted">
          ~{formatRows(d.rel.estimated_rows)}
        </span>
      )}
      {d.ntype === "relation" && (
        <button
          className={cn(
            "ml-1 shrink-0 opacity-0 group-hover:opacity-100",
            isPinned(d) && "text-fg opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onPin(d);
          }}
          title="Pin"
        >
          <Pin size={11} className={cn(isPinned(d) ? "fill-current" : "text-fg-muted")} />
        </button>
      )}
    </div>
  );
}
