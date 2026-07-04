// The Explorer tree model + pure transforms. No JSX → plain, testable functions.
// react-arborist renders these nodes.
import type { SchemaSnapshot, SnapFn, SnapRel } from "@/lib/api";
import type { ExplorerFilter } from "@/stores/schemaStore";

export interface TreeNode {
  id: string;
  name: string;
  ntype: "schema" | "category" | "relation" | "function" | "more";
  schema?: string;
  rel?: SnapRel;
  fn?: SnapFn;
  isSystem?: boolean;
  /// Which category filter a "more" node opens.
  moreWhich?: "rel" | "fn";
  children?: TreeNode[];
}

/// Max objects shown per category. If exceeded, the first CAP + a "N more — filter to
/// narrow" node; keeps a 2000-table tree from choking.
export const CATEGORY_CAP = 200;

/// Snapshot → a 3-level tree: schema → category → object. System schemas
/// (pg_catalog/information_schema) aren't shown — their objects aren't fetched into
/// the cache, so they shouldn't appear as empty nodes.
export function buildTree(snap: SchemaSnapshot): TreeNode[] {
  return snap.schemas
    .filter((sc) => !sc.is_system)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((sc) => {
      const cats: TreeNode[] = [];
      const group = (label: string, which: "rel" | "fn", rels: SnapRel[]) => {
        if (rels.length === 0) return;
        cats.push({
          id: `${sc.name}:${label}`,
          name: `${label} (${rels.length})`,
          ntype: "category",
          children: capChildren(
            rels,
            (r) => ({
              id: `${sc.name}.${r.name}`,
              name: r.name,
              ntype: "relation" as const,
              schema: sc.name,
              rel: r,
            }),
            `${sc.name}:${label}`,
            which,
          ),
        });
      };
      group(
        "Tables",
        "rel",
        sc.relations.filter(
          (r) => r.kind === "table" || r.kind === "partitioned" || r.kind === "foreign",
        ),
      );
      group("Views", "rel", sc.relations.filter((r) => r.kind === "view"));
      group("Materialized", "rel", sc.relations.filter((r) => r.kind === "mat_view"));
      group("Sequences", "rel", sc.relations.filter((r) => r.kind === "sequence"));
      if (sc.functions.length > 0) {
        cats.push({
          id: `${sc.name}:Functions`,
          name: `Functions (${sc.functions.length})`,
          ntype: "category",
          children: capChildren(
            sc.functions,
            (f) => ({
              id: `${sc.name}.fn.${f.oid}`,
              name: f.name,
              ntype: "function" as const,
              schema: sc.name,
              fn: f,
            }),
            `${sc.name}:Functions`,
            "fn",
          ),
        });
      }
      return {
        id: `schema:${sc.name}`,
        name: sc.name,
        ntype: "schema" as const,
        isSystem: sc.is_system,
        children: cats,
      };
    });
}

/// Produces a category's children up to the cap; if exceeded, the first CATEGORY_CAP
/// (sorted by name) + a "more" node.
function capChildren<T extends { name: string }>(
  items: T[],
  toNode: (item: T) => TreeNode,
  catId: string,
  which: "rel" | "fn",
): TreeNode[] {
  if (items.length <= CATEGORY_CAP) return items.map(toNode);
  const sorted = items.slice().sort((a, b) => a.name.localeCompare(b.name));
  const shown = sorted.slice(0, CATEGORY_CAP).map(toNode);
  const rest = items.length - CATEGORY_CAP;
  shown.push({
    id: `${catId}:more`,
    name: `${rest.toLocaleString()} more — filter to narrow`,
    ntype: "more",
    moreWhich: which,
  });
  return shown;
}

/// A flat object list to drop nesting while searching. System schemas are skipped
/// (they're empty anyway).
export function flatten(snap: SchemaSnapshot): TreeNode[] {
  const out: TreeNode[] = [];
  for (const sc of snap.schemas) {
    if (sc.is_system) continue;
    for (const r of sc.relations) {
      out.push({
        id: `${sc.name}.${r.name}`,
        name: r.name,
        ntype: "relation",
        schema: sc.name,
        rel: r,
      });
    }
    for (const f of sc.functions) {
      out.push({
        id: `${sc.name}.fn.${f.oid}`,
        name: f.name,
        ntype: "function",
        schema: sc.name,
        fn: f,
      });
    }
  }
  return out;
}

/// Applies the Explorer filter to a snapshot: name substring + kind. Returns a new
/// snapshot; buildTree/flatten see it, and the counts update too.
export function filterSnapshot(snap: SchemaSnapshot, f: ExplorerFilter): SchemaSnapshot {
  const relName = f.rel.name.trim().toLowerCase();
  const fnName = f.fn.name.trim().toLowerCase();
  const relKinds = new Set(f.rel.kinds);
  const fnKinds = new Set(f.fn.kinds);
  if (!relName && !fnName && relKinds.size === 0 && fnKinds.size === 0) return snap;
  return {
    ...snap,
    schemas: snap.schemas.map((sc) => ({
      ...sc,
      relations: sc.relations.filter(
        (r) =>
          (!relName || r.name.toLowerCase().includes(relName)) &&
          (relKinds.size === 0 || relKinds.has(r.kind)),
      ),
      functions: sc.functions.filter((fn) => {
        if (fnName && !fn.name.toLowerCase().includes(fnName)) return false;
        if (fnKinds.size === 0) return true;
        if (fn.is_trigger && fnKinds.has("trigger")) return true;
        return fnKinds.has(fn.kind);
      }),
    })),
  };
}

/// Nodes open at startup: the active schema (search_path[0] / "public" / the first
/// user schema) + its "Tables" category (so public is visible right away). Passed to
/// react-arborist's `initialOpenState`.
export function defaultOpenState(snap: SchemaSnapshot): Record<string, boolean> {
  const userSchemas = snap.schemas.filter((s) => !s.is_system).map((s) => s.name);
  if (userSchemas.length === 0) return {};
  const preferred = snap.search_path.find((s) => userSchemas.includes(s));
  const active =
    preferred ?? (userSchemas.includes("public") ? "public" : userSchemas[0]);
  return { [`schema:${active}`]: true, [`${active}:Tables`]: true };
}

export function formatRows(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
