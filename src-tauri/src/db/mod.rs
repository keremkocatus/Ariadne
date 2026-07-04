//! Database layer. Unaware of Tauri — pure DB logic, testable without a UI.
//! Responsibilities are split across files:
//!
//! - [`pool`]     — profile → PgPool setup
//! - [`types`]    — IPC contract types (RunResult, Page, TxStatus, …)
//! - [`classify`] — statement classification (rows / destructive / tx)
//! - [`rows`]     — PgRow → text cells
//! - [`exec`]     — cursored execution lifecycle (the actual engine)

pub mod classify;
pub mod exec;
pub mod pool;
pub mod rows;
pub mod types;

pub use pool::build_pool;

use classify::first_keyword;

/// Whether any statement changes the schema (DDL) — the trigger for cache
/// auto-refresh. pg_query split + first keyword; cheap and covers ~90% of cases.
pub fn touches_schema(sql: &str) -> bool {
    let stmts = pg_query::split_with_parser(sql).unwrap_or_default();
    stmts.iter().any(|s| {
        matches!(
            first_keyword(s).as_str(),
            "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "COMMENT" | "GRANT" | "REVOKE"
        )
    })
}
