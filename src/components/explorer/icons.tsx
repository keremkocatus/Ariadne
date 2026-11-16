// Tree node → lucide icon (single-color stroke, monochrome).
import { Eye, Folder, FunctionSquare, Hash, Layers, Rows3, Table2, Globe } from "lucide-react";
import type { RelKind } from "@/lib/api";
import type { TreeNode } from "./tree";

const BASE = "shrink-0 text-fg-muted";

export function relationIcon(kind: RelKind | "other" | undefined, size = 12, className = BASE) {
  switch (kind) {
    case "view":
    case "mat_view":
      return <Eye size={size} className={className} />;
    case "sequence":
      return <Hash size={size} className={className} />;
    case "partitioned":
      return <Layers size={size} className={className} />;
    case "foreign":
      return <Globe size={size} className={className} />;
    default:
      return <Table2 size={size} className={className} />;
  }
}

export function iconFor(n: TreeNode) {
  switch (n.ntype) {
    case "schema":
    case "category":
      return <Folder size={12} className={BASE} />;
    case "function":
      return <FunctionSquare size={12} className={BASE} />;
    case "relation":
      // A leaf partition gets a lighter "slice" glyph so the parent stands out.
      if (n.shortName != null && n.rel?.kind !== "partitioned") {
        return <Rows3 size={12} className="shrink-0 text-fg-subtle" />;
      }
      return relationIcon(n.rel?.kind);
    default:
      return null;
  }
}
