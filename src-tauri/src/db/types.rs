//! IPC contract types: the return shapes for run_query / fetch_page. Pure data
//! that mirrors the TypeScript types in `api.ts` one-to-one; no behavior.

use serde::Serialize;

use crate::error::AriadneError;

#[derive(Debug, Serialize)]
pub struct RunResult {
    pub query_id: String,
    pub statements: Vec<StatementResult>,
    pub tx_status: TxStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_confirmation: Option<Confirmation>,
    /// If a statement failed: the statements accumulated so far are kept and the
    /// error is returned here (psql-like partial results). Remaining statements
    /// are not executed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AriadneError>,
    /// 0-based index of the failed statement in the script (for a "statement N" message).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_statement_index: Option<usize>,
}

/// The single table a plain SELECT reads from — the basis for cell editing.
/// `schema` is `None` when the SQL didn't qualify the name (resolved downstream via
/// search_path).
#[derive(Debug, Clone, Serialize)]
pub struct SourceTable {
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StatementResult {
    Rows {
        columns: Vec<ColumnMeta>,
        first_page: Page,
        truncated_cells: bool,
        /// Present only when the statement was a plain single-table SELECT
        /// (no joins/set-ops/GROUP BY/DISTINCT/CTEs) — grid rows then map 1:1 to
        /// physical rows, so cell editing is safe to offer.
        #[serde(skip_serializing_if = "Option::is_none")]
        source_table: Option<SourceTable>,
    },
    Affected {
        command: String,
        row_count: u64,
    },
    Empty {
        command: String,
    },
}

#[derive(Debug, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
    pub type_oid: u32,
}

#[derive(Debug, Serialize)]
pub struct Page {
    pub rows: Vec<Vec<Option<String>>>,
    pub has_more: bool,
    pub fetched_total: usize,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TxStatus {
    Idle,
    InTransaction,
    Aborted,
}

#[derive(Debug, Serialize)]
pub struct Confirmation {
    pub statement_index: usize,
    pub kind: String, // "update" | "delete" | "truncate"
    pub table: String,
    pub estimated_rows: Option<i64>,
}
