// Helpers for single-cell editing. Decides whether a result cell is editable and
// resolves the primary-key columns (on-demand, memoized). Editing is enabled only
// when THREE conditions all hold: (a) the tab was opened from a table (sourceTable),
// (b) the table's PK resolves, (c) the PK columns are present in the result with
// non-null values (so a WHERE can be built). Otherwise it's a read-only viewer.

import { getPrimaryKey, type ColumnMeta, type PkPredicate } from "@/lib/api";

const pkCache = new Map<string, Promise<string[]>>();

/// Resolves a table's PK columns (memoized). Failures are NOT cached → the next
/// attempt asks again.
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

/// Builds the WHERE predicate from the PK columns in the result row; if it can't,
/// returns the reason.
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
