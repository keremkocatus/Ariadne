// Explorer ağaç modeli + saf dönüşümler (design 07 §2). JSX içermez → test
// edilebilir düz fonksiyonlar. react-arborist bu düğümleri render eder.
import type { SchemaSnapshot, SnapFn, SnapRel } from "@/lib/api";
import type { ExplorerFilter } from "@/stores/schemaStore";

export interface TreeNode {
  id: string;
  name: string;
  ntype: "schema" | "category" | "relation" | "function";
  schema?: string;
  rel?: SnapRel;
  fn?: SnapFn;
  isSystem?: boolean;
  children?: TreeNode[];
}

/// Snapshot → 3 seviyeli ağaç: schema → kategori → nesne (design 07 §2).
export function buildTree(snap: SchemaSnapshot): TreeNode[] {
  return snap.schemas
    .slice()
    .sort((a, b) => Number(a.is_system) - Number(b.is_system) || a.name.localeCompare(b.name))
    .map((sc) => {
      const cats: TreeNode[] = [];
      const group = (label: string, rels: SnapRel[]) => {
        if (rels.length === 0) return;
        cats.push({
          id: `${sc.name}:${label}`,
          name: `${label} (${rels.length})`,
          ntype: "category",
          children: rels.map((r) => ({
            id: `${sc.name}.${r.name}`,
            name: r.name,
            ntype: "relation",
            schema: sc.name,
            rel: r,
          })),
        });
      };
      group(
        "Tables",
        sc.relations.filter(
          (r) => r.kind === "table" || r.kind === "partitioned" || r.kind === "foreign",
        ),
      );
      group("Views", sc.relations.filter((r) => r.kind === "view"));
      group("Materialized", sc.relations.filter((r) => r.kind === "mat_view"));
      group("Sequences", sc.relations.filter((r) => r.kind === "sequence"));
      if (sc.functions.length > 0) {
        cats.push({
          id: `${sc.name}:Functions`,
          name: `Functions (${sc.functions.length})`,
          ntype: "category",
          children: sc.functions.map((f) => ({
            id: `${sc.name}.fn.${f.oid}`,
            name: f.name,
            ntype: "function",
            schema: sc.name,
            fn: f,
          })),
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

/// Aramada nesting'ten kurtulmak için düz nesne listesi (design 07 §2).
export function flatten(snap: SchemaSnapshot): TreeNode[] {
  const out: TreeNode[] = [];
  for (const sc of snap.schemas) {
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

/// Explorer filtresini snapshot'a uygular (design 15 §P1-U3): ad substring + tür.
/// Yeni bir snapshot döndürür; buildTree/flatten bunu görür, count'lar da güncellenir.
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

export function formatRows(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
