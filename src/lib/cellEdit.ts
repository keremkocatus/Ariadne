// Tek-hücre düzenleme yardımcıları (design 19 §P1-X4 N8). Bir sonuç hücresinin
// düzenlenebilir olup olmadığını belirler ve PK kolonlarını (on-demand, memoized)
// çözer. Düzenleme yalnız ÜÇ koşul birden sağlanınca açık: (a) tab bir tablodan
// açılmış (sourceTable), (b) tablonun PK'sı çözülür, (c) PK kolonları sonuçta var
// ve değerleri null değil (WHERE kurulabilsin). Aksi halde salt-görüntüleyici.

import { getPrimaryKey, type ColumnMeta, type PkPredicate } from "@/lib/api";

const pkCache = new Map<string, Promise<string[]>>();

/// Bir tablonun PK kolonlarını çözer (memoized). Başarısızlık önbelleğe ALINMAZ →
/// sonraki denemede tekrar sorulur.
export async function resolvePrimaryKey(
  connectionId: string,
  schema: string,
  name: string,
): Promise<string[]> {
  const key = `${connectionId}:${schema}.${name}`;
  const cached = pkCache.get(key);
  if (cached) return cached;
  const p = getPrimaryKey(connectionId, schema, name);
  pkCache.set(key, p);
  try {
    return await p;
  } catch (e) {
    pkCache.delete(key);
    throw e;
  }
}

export type Editability =
  | { editable: true; pk: PkPredicate[] }
  | { editable: false; reason: string };

/// Sonuç satırında PK kolonlarından WHERE yüklemini kurar; kuramıyorsa nedeni döner.
export function buildEditability(
  pkColumns: string[],
  columns: ColumnMeta[],
  row: (string | null)[],
): Editability {
  if (pkColumns.length === 0) {
    return { editable: false, reason: "read-only — table has no primary key" };
  }
  const pk: PkPredicate[] = [];
  for (const col of pkColumns) {
    const idx = columns.findIndex((c) => c.name === col);
    if (idx === -1) {
      return { editable: false, reason: "read-only — primary key not in result columns" };
    }
    const value = row[idx];
    if (value === null) {
      return { editable: false, reason: "read-only — primary key value is NULL" };
    }
    pk.push({ column: col, value });
  }
  return { editable: true, pk };
}
