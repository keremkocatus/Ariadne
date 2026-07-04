// Explorer ağaç modeli + saf dönüşümler (design 07 §2). JSX içermez → test
// edilebilir düz fonksiyonlar. react-arborist bu düğümleri render eder.
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
  /// "more" düğümünün hangi kategori filtresini açacağı (design 18 §P1-W2 N4).
  moreWhich?: "rel" | "fn";
  children?: TreeNode[];
}

/// Kategori başına gösterilen maks nesne (design 18 §P1-W2 N4). Aşılırsa ilk
/// CAP tanesi + "N more — filter to narrow" düğümü; 2000 tablo ağacı kastırmasın.
export const CATEGORY_CAP = 200;

/// Snapshot → 3 seviyeli ağaç: schema → kategori → nesne (design 07 §2).
/// Sistem şemaları (pg_catalog/information_schema) gösterilmez — nesneleri cache'e
/// çekilmiyor, boş düğüm olarak görünmesinler (design 18 §P1-W2 N5).
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

/// Bir kategorinin çocuklarını tavana kadar üretir; aşılırsa ilk CATEGORY_CAP
/// (ada göre sıralı) + bir "more" düğümü (design 18 §P1-W2 N4).
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

/// Aramada nesting'ten kurtulmak için düz nesne listesi (design 07 §2). Sistem
/// şemaları atlanır (zaten boşlar — design 18 §P1-W2 N5).
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

/// Açılışta açık olacak düğümler: aktif şema (search_path[0] / "public" / ilk
/// kullanıcı şeması) + onun "Tables" kategorisi (design 18 §P1-W2 N3 — public
/// hemen görünsün). react-arborist `initialOpenState`'ine verilir.
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
