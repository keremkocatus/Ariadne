// AriadneError presentation is normalized in one place. The Monaco marker decision
// lives in App.tsx (when a position exists); the banner/title live here.
import type { AriadneError } from "./api";

// Common SQLSTATE codes → human-readable title (~20 codes; the rest use the raw message).
const SQLSTATE_TITLES: Record<string, string> = {
  "42P01": "Table not found",
  "42703": "Column not found",
  "42601": "Syntax error",
  "42P07": "Duplicate table",
  "42701": "Duplicate column",
  "42883": "Function not found",
  "42P18": "Indeterminate datatype",
  "23505": "Unique violation",
  "23503": "Foreign key violation",
  "23502": "Not-null violation",
  "23514": "Check violation",
  "22P02": "Invalid text representation",
  "22001": "Value too long",
  "22003": "Numeric out of range",
  "22012": "Division by zero",
  "28P01": "Invalid password",
  "28000": "Invalid authorization",
  "3D000": "Database does not exist",
  "40001": "Serialization failure",
  "40P01": "Deadlock detected",
  "53300": "Too many connections",
  "57014": "Query cancelled",
  "25P02": "Transaction aborted — rollback first",
  "25006": "Read-only transaction",
  "0A000": "Feature not supported",
};

/// Whether a read-only violation (SQLSTATE 25006) comes from the profile setting.
/// If so, an extra hint is shown in the error banner.
export function readOnlyProfileHint(e: AriadneError, isReadOnlyProfile: boolean): string | null {
  if (e.sqlstate === "25006" && isReadOnlyProfile) {
    return "This profile is read-only (profile setting) — edit the profile or use BEGIN READ WRITE deliberately.";
  }
  return null;
}

const KIND_TITLES: Record<AriadneError["kind"], string> = {
  connection_failed: "Connection failed",
  connection_lost: "Connection lost",
  query_error: "Query error",
  query_cancelled: "Query cancelled",
  timeout: "Timeout",
  parse_error: "Parse error",
  keyring_error: "Keyring error",
  internal: "Unexpected error",
};

/// Short, human-readable title: SQLSTATE table first, then a kind fallback.
export function errorTitle(e: AriadneError): string {
  if (e.sqlstate && SQLSTATE_TITLES[e.sqlstate]) return SQLSTATE_TITLES[e.sqlstate];
  return KIND_TITLES[e.kind] ?? "Error";
}
