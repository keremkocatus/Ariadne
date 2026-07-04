//! IPC sözleşme tipleri (design 02 §3): run_query / fetch_page dönüş şekilleri.
//! Saf veri; frontend'deki `api.ts` tipleriyle birebir. Hiçbir davranış içermez.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct RunResult {
    pub query_id: String,
    pub statements: Vec<StatementResult>,
    pub tx_status: TxStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_confirmation: Option<Confirmation>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StatementResult {
    Rows {
        columns: Vec<ColumnMeta>,
        first_page: Page,
        truncated_cells: bool,
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
