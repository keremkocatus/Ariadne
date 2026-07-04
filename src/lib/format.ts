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
