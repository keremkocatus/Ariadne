// The Explorer tree model + pure transforms. No JSX → plain, testable functions.
// react-arborist renders these nodes.
import type { SchemaSnapshot, SnapFn, SnapRel } from "@/lib/api";
import type { ExplorerFilter } from "@/stores/schemaStore";
import { partitionLabel } from "@/lib/pgFormat";

export interface TreeNode {
  id: string;
  name: string;
  ntype: "schema" | "category" | "relation" | "function" | "more";
  schema?: string;
  rel?: SnapRel;
  fn?: SnapFn;
  isSystem?: boolean;
  /// For a category: what it holds. Drives its icon and which filter applies to it.
  group?: CategoryGroup;
  /// Which category filter a "more" node opens.
  moreWhich?: "rel" | "fn";
  /// For a partition nested under its parent: the name with the parent's prefix
  /// removed (`event_logs_y2026m11` → `y2026m11`).
  shortName?: string;
  /// For a table with partitions: how many there are in total (all levels), and the
  /// row estimate summed over the leaves — the parent's own reltuples is not kept up
  /// to date by Postgres.
  partitionCount?: number;
  partitionRows?: number;
  children?: TreeNode[];
}

export type CategoryGroup =
  | "tables"
  | "views"
  | "mat_views"
  | "sequences"
  | "functions"
  | "fn_user"
  | "fn_trigger"
  | "fn_system";

const GROUP_OF: Record<string, CategoryGroup> = {
  Tables: "tables",
  Views: "views",
  Materialized: "mat_views",
  Sequences: "sequences",
};

/// Max objects shown per category. If exceeded, the first CAP + a "N more — filter to
/// narrow" node; keeps a 2000-table tree from choking.
export const CATEGORY_CAP = 200;

/// Snapshot → a tree: schema → category → object, with partitions nested under their
/// parent table. System schemas (pg_catalog/information_schema) aren't shown — their
/// objects aren't fetched into the cache, so they shouldn't appear as empty nodes.
export function buildTree(snap: SchemaSnapshot): TreeNode[] {
  // Partitions hang under their parent wherever it lives, so the lookup spans all
  // schemas. It is built from the snapshot as given: when a filter has removed the
  // parent, its partitions fall back to being listed as ordinary tables.
  const byOid = new Map<number, SnapRel>();
  const childrenOf = new Map<number, { schema: string; rel: SnapRel }[]>();
  for (const sc of snap.schemas) {
    for (const r of sc.relations) byOid.set(r.oid, r);
  }
  for (const sc of snap.schemas) {
    for (const r of sc.relations) {
      if (r.parent_oid != null && byOid.has(r.parent_oid)) {
        const list = childrenOf.get(r.parent_oid) ?? [];
        list.push({ schema: sc.name, rel: r });
        childrenOf.set(r.parent_oid, list);
      }
    }
  }
  const isNested = (r: SnapRel) => r.parent_oid != null && byOid.has(r.parent_oid);

  const relNode = (schema: string, r: SnapRel, parent?: SnapRel): TreeNode => {
    const node: TreeNode = {
      id: `${schema}.${r.name}`,
      name: r.name,
      ntype: "relation",
      schema,
      rel: r,
      shortName: parent ? partitionLabel(r.name, parent.name) : undefined,
    };
    const kids = childrenOf.get(r.oid);
    if (kids && kids.length > 0) {
      node.children = kids
        .slice()
        .sort((a, b) => a.rel.name.localeCompare(b.rel.name, undefined, { numeric: true }))
        .map((k) => relNode(k.schema, k.rel, r));
      node.partitionCount = node.children.reduce((n, c) => n + 1 + (c.partitionCount ?? 0), 0);
      node.partitionRows = node.children.reduce(
        (n, c) => n + (c.children ? (c.partitionRows ?? 0) : Math.max(0, c.rel?.estimated_rows ?? 0)),
        0,
      );
    }
    return node;
  };

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
          group: GROUP_OF[label],
          children: capChildren(rels, (r) => relNode(sc.name, r), `${sc.name}:${label}`, which),
        });
      };
      group(
        "Tables",
        "rel",
        sc.relations.filter(
          (r) =>
            (r.kind === "table" || r.kind === "partitioned" || r.kind === "foreign") && !isNested(r),
        ),
      );
      group("Views", "rel", sc.relations.filter((r) => r.kind === "view"));
      group("Materialized", "rel", sc.relations.filter((r) => r.kind === "mat_view"));
      group("Sequences", "rel", sc.relations.filter((r) => r.kind === "sequence"));
      if (sc.functions.length > 0) {
        const fnId = `${sc.name}:Functions`;
        const fnNodes = (fns: SnapFn[], catId: string) =>
          capChildren(
            fns,
            (f) => ({
              id: `${sc.name}.fn.${f.oid}`,
              name: f.name,
              ntype: "function" as const,
              schema: sc.name,
              fn: f,
            }),
            catId,
            "fn",
          );
        const fromExt = sc.functions.filter((f) => f.extension);
        const triggers = sc.functions.filter((f) => !f.extension && f.is_trigger);
        const own = sc.functions.filter((f) => !f.extension && !f.is_trigger);
        const sub = (key: string, label: string, group: CategoryGroup, fns: SnapFn[]): TreeNode[] =>
          fns.length === 0
            ? []
            : [
                {
                  id: `${fnId}:${key}`,
                  name: `${label} (${fns.length})`,
                  ntype: "category",
                  group,
                  children: fnNodes(fns, `${fnId}:${key}`),
                },
              ];
        // An extension can drop hundreds of functions into a schema, and trigger
        // functions are never called by hand; grouping both apart keeps the callable
        // functions the user wrote easy to reach. When everything is of that one
        // kind the extra level would only add a click.
        const children: TreeNode[] =
          fromExt.length === 0 && triggers.length === 0
            ? fnNodes(own, fnId)
            : [
                ...sub("user", "User-defined", "fn_user", own),
                ...sub("triggers", "Triggers", "fn_trigger", triggers),
                ...sub("system", "System functions", "fn_system", fromExt),
              ];
        cats.push({
          id: fnId,
          name: `Functions (${sc.functions.length})`,
          ntype: "category",
          group: "functions",
          children,
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
  const open: Record<string, boolean> = { [`schema:${active}`]: true, [`${active}:Tables`]: true };
  // Opening "Functions" should land on the user's own functions straight away; the
  // extension group stays closed.
  for (const s of userSchemas) open[`${s}:Functions:user`] = true;
  return open;
}

/// The parent table of a partition, when it is in the snapshot.
export function findParent(
  snap: SchemaSnapshot,
  rel: SnapRel,
): { schema: string; rel: SnapRel } | null {
  if (rel.parent_oid == null) return null;
  for (const sc of snap.schemas) {
    const parent = sc.relations.find((r) => r.oid === rel.parent_oid);
    if (parent) return { schema: sc.name, rel: parent };
  }
  return null;
}

/// The direct partitions of a table, name-sorted.
export function findPartitions(snap: SchemaSnapshot, rel: SnapRel): { schema: string; rel: SnapRel }[] {
  const out: { schema: string; rel: SnapRel }[] = [];
  for (const sc of snap.schemas) {
    for (const r of sc.relations) {
      if (r.parent_oid === rel.oid) out.push({ schema: sc.name, rel: r });
    }
  }
  return out.sort((a, b) => a.rel.name.localeCompare(b.rel.name, undefined, { numeric: true }));
}
