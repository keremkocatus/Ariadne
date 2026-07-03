// Frontend ↔ Rust sözleşmesi (design 02). Tipler Rust'taki serde tipleriyle
// birebir tutulur; Faz 1'de ts-rs ile otomatik üretime geçilebilir.
import { invoke } from "@tauri-apps/api/core";

// ---- Hata modeli (design 02 §2) ----
export type ErrorKind =
  | "connection_failed"
  | "connection_lost"
  | "query_error"
  | "query_cancelled"
  | "timeout"
  | "parse_error"
  | "keyring_error"
  | "internal";

export interface AriadneError {
  kind: ErrorKind;
  message: string;
  detail?: string;
  sqlstate?: string;
  position?: number;
  hint?: string;
}

// ---- Query (design 02 §3) ----
export interface ColumnMeta {
  name: string;
  type_name: string;
  type_oid: number;
}

export interface Page {
  rows: (string | null)[][];
  has_more: boolean;
  fetched_total: number;
  elapsed_ms: number;
}

export type StatementResult =
  | { kind: "rows"; columns: ColumnMeta[]; first_page: Page; truncated_cells: boolean }
  | { kind: "affected"; command: string; row_count: number }
  | { kind: "empty"; command: string };

export type TxStatus = "idle" | "in_transaction" | "aborted";

export interface RunResult {
  query_id: string;
  statements: StatementResult[];
  tx_status: TxStatus;
}

// M0: tek hardcoded bağlantı, cursor yok. connection_id/tab_id ileride eklenecek.
export function runQuery(sql: string): Promise<RunResult> {
  return invoke<RunResult>("run_query", { sql });
}

// Hata tip guard'ı — invoke reject'i AriadneError taşır.
export function isAriadneError(e: unknown): e is AriadneError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    "message" in e
  );
}
