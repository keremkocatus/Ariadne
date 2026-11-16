// Tree node → lucide icon (single-color stroke, monochrome).
import {
  Box,
  Braces,
  Eye,
  Folder,
  Globe,
  Hash,
  Layers,
  Puzzle,
  Rows3,
  SquareFunction,
  Table2,
  Zap,
} from "lucide-react";
import type { RelKind } from "@/lib/api";
import type { CategoryGroup, TreeNode } from "./tree";

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

// A group carries the glyph of what it holds, so a schema's children can be told
// apart without reading the labels.
function categoryIcon(group: CategoryGroup | undefined) {
  switch (group) {
    case "tables":
      return <Table2 size={12} className={BASE} />;
    case "views":
    case "mat_views":
      return <Eye size={12} className={BASE} />;
    case "sequences":
      return <Hash size={12} className={BASE} />;
    case "functions":
      return <SquareFunction size={12} className={BASE} />;
    case "fn_user":
      return <Braces size={12} className={BASE} />;
    case "fn_trigger":
      return <Zap size={12} className={BASE} />;
    case "fn_system":
      return <Puzzle size={12} className={BASE} />;
    default:
      return <Folder size={12} className={BASE} />;
  }
}

export function iconFor(n: TreeNode) {
  switch (n.ntype) {
    case "schema":
      return <Box size={12} className={BASE} />;
    case "category":
      return categoryIcon(n.group);
    case "function":
      return n.fn?.is_trigger ? (
        <Zap size={12} className={BASE} />
      ) : (
        <SquareFunction size={12} className={BASE} />
      );
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
