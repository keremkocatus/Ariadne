// Tree node → lucide icon (single-color stroke, monochrome).
import { Eye, Folder, FunctionSquare, Hash, Layers, Table2 } from "lucide-react";
import type { TreeNode } from "./tree";

export function iconFor(n: TreeNode) {
  const c = "shrink-0 text-fg-muted";
  switch (n.ntype) {
    case "schema":
    case "category":
      return <Folder size={12} className={c} />;
    case "function":
      return <FunctionSquare size={12} className={c} />;
    case "relation":
      switch (n.rel?.kind) {
        case "view":
        case "mat_view":
          return <Eye size={12} className={c} />;
        case "sequence":
          return <Hash size={12} className={c} />;
        case "foreign":
        case "partitioned":
          return <Layers size={12} className={c} />;
        default:
          return <Table2 size={12} className={c} />;
      }
  }
}
