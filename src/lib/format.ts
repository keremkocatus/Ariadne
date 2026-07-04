import { format } from "sql-formatter";

/// Rewrites SQL in a readable form. PostgreSQL dialect, UPPERCASE keywords, 2-space
/// indent. A pure, testable function.
///
/// sql-formatter can throw on some Postgres-specific syntax (dollar-quoted bodies,
/// exotic operators) → the caller must guard with try/catch and preserve the text.
export function formatSql(sql: string): string {
  return format(sql, {
    language: "postgresql",
    keywordCase: "upper",
    tabWidth: 2,
  });
}

/// Human-readable byte size (1 decimal, binary units).
export function formatBytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
