// react-arborist node renderer: icon + name + row estimate + pin button.
import { type NodeRendererProps } from "react-arborist";
import { ChevronRight, Pin } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBound, formatCount } from "@/lib/pgFormat";
import { type TreeNode } from "./tree";
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
  // An object row peeks on click. A partitioned table is an object AND a parent, so
  // only its chevron expands it; for pure groups the whole row toggles.
  const isObject = d.ntype === "relation" || d.ntype === "function";
  const expandable = !node.isLeaf;
  const isPartition = d.shortName != null;
  const bound = isPartition ? formatBound(d.rel?.partition_bound) : "";
  const label = d.shortName ?? d.name;
  const rows = d.partitionCount ? (d.partitionRows ?? 0) : (d.rel?.estimated_rows ?? 0);

  return (
    <div
      style={style}
      className={cn(
        // w-0 + min-w-full: the tree sizes each row to its max-content, which would
        // turn a long name into a horizontal scrollbar; this keeps the row at the
        // panel's width so the name truncates instead.
        "group flex h-6 w-0 min-w-full cursor-pointer items-center gap-1 pr-1 text-xs transition-colors hover:bg-bg-hover",
        node.isSelected && "bg-bg-hover",
      )}
      title={isPartition && d.rel?.partition_bound ? `${d.name} — ${d.rel.partition_bound}` : d.name}
      onClick={() => {
        if (isObject) onPeek(d);
        else node.toggle();
      }}
      onDoubleClick={() => isObject && onActivate(d)}
      onContextMenu={(e) => onContextMenu(d, e)}
    >
      {expandable ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={node.isOpen ? "Collapse" : "Expand"}
          className="flex h-6 w-3 shrink-0 items-center justify-center text-fg-muted hover:text-fg"
          onClick={(e) => {
            // Toggle without also peeking the table.
            e.stopPropagation();
            node.toggle();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <ChevronRight size={12} className={cn("transition-transform", node.isOpen && "rotate-90")} />
        </button>
      ) : (
        <span className="w-3 shrink-0" />
      )}
      {iconFor(d)}
      <span className={cn("truncate", isPartition && "font-mono text-[11px]")}>{label}</span>
      {/* The bound repeats the label for a `…_default` partition; show it only when it adds something. */}
      {bound && bound !== label && (
        <span className="min-w-0 shrink-[4] truncate text-[10px] text-fg-subtle">{bound}</span>
      )}
      {d.ntype === "category" && isFiltered(d) && (
        <span className="shrink-0 rounded bg-warn/20 px-1 text-[9px] text-warn">filtered</span>
      )}
      {d.partitionCount != null && d.partitionCount > 0 && (
        <span
          className="shrink-0 rounded-full bg-fg/8 px-1.5 text-[9px] tabular-nums leading-[14px] text-fg-muted"
          title={`${d.partitionCount} partition${d.partitionCount === 1 ? "" : "s"}`}
        >
          {d.partitionCount}
        </span>
      )}
      {d.rel && rows > 0 && (
        <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-fg-muted">
          ~{formatCount(rows)}
        </span>
      )}
      {d.ntype === "relation" && (
        <button
          className={cn(
            "shrink-0 opacity-0 group-hover:opacity-100",
            d.rel && rows > 0 ? "ml-1" : "ml-auto",
            isPinned(d) && "text-fg opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onPin(d);
          }}
          title={isPinned(d) ? "Unpin" : "Pin"}
        >
          <Pin size={11} className={cn(isPinned(d) ? "fill-current" : "text-fg-muted")} />
        </button>
      )}
    </div>
  );
}
