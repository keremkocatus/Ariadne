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
    /// What the failed statement was, so the Messages list can show it as a row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_statement: Option<StmtMeta>,
    /// How many statements the script contained; more than `statements.len()` when a
    /// failure or a pending confirmation stopped the run early.
    pub total_statements: usize,
}

/// The single table a plain SELECT reads from — the basis for cell editing.
/// `schema` is `None` when the SQL didn't qualify the name (resolved downstream via
/// search_path).
#[derive(Debug, Clone, Serialize)]
pub struct SourceTable {
    pub schema: Option<String>,
    pub name: String,
}

/// Per-statement bookkeeping shared by every result kind: what ran and how long it
/// took. Feeds the "Messages" list of a multi-statement run.
#[derive(Debug, Default, Serialize)]
pub struct StmtMeta {
    /// Command tag, e.g. "SELECT", "CREATE FUNCTION", "COMMIT".
    pub command: String,
    /// The statement's text, comments stripped and collapsed to one short line.
    pub preview: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StatementResult {
    Rows {
        #[serde(flatten)]
        meta: StmtMeta,
        columns: Vec<ColumnMeta>,
        first_page: Page,
        truncated_cells: bool,
        /// The result was cut at one page and can't be paged further: only the last
        /// statement of a script keeps a cursor open.
        partial: bool,
        /// Present only when the statement was a plain single-table SELECT
        /// (no joins/set-ops/GROUP BY/DISTINCT/CTEs) — grid rows then map 1:1 to
        /// physical rows, so cell editing is safe to offer.
        #[serde(skip_serializing_if = "Option::is_none")]
        source_table: Option<SourceTable>,
    },
    Affected {
        #[serde(flatten)]
        meta: StmtMeta,
        row_count: u64,
    },
    Empty {
        #[serde(flatten)]
        meta: StmtMeta,
    },
}

impl StatementResult {
    pub fn meta_mut(&mut self) -> &mut StmtMeta {
        match self {
            Self::Rows { meta, .. } | Self::Affected { meta, .. } | Self::Empty { meta } => meta,
        }
    }
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
