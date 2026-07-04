//! Query commands: cursored execution, pagination, cancel, per-tab session
//! transactions, and the destructive guard.
//!
//! API note: the run_query request carries a client-generated `query_id` (used to
//! cancel it while running); fetch_page/cancel/close additionally take a
//! `connection_id`. The frontend knows both.

use tauri::{AppHandle, State};

use crate::db::exec::{self, RunArgs, PAGE_SIZE};
use crate::db::touches_schema;
use crate::db::types::{Page, RunResult};
use crate::error::AriadneError;
use crate::state::AppState;

use super::schema::spawn_cache_refresh;

// Tauri IPC boundary: each argument is deserialized separately from the JS invoke
// payload; packing them into a struct would break the api.ts contract. Deliberate.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn run_query(
    connection_id: String,
    sql: String,
    tab_id: String,
    query_id: String,
    confirmed: Option<bool>,
    max_rows_per_page: Option<i64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RunResult, AriadneError> {
    let conn = state.connection(&connection_id)?;
    // SQL text only at debug level; duration/result at info.
    tracing::debug!(query_id = %query_id, sql = %sql, "run_query");
    let started = std::time::Instant::now();
    let mut result = exec::run_query(
        &conn.exec,
        &conn.pool,
        RunArgs {
            sql: &sql,
            tab_id: &tab_id,
            query_id: &query_id,
            confirmed: confirmed.unwrap_or(false),
            page_size: max_rows_per_page.unwrap_or(PAGE_SIZE),
        },
    )
    .await?;

    // Fill the destructive guard's row estimate from the cache. The db layer is
    // unaware of the cache; the estimate is added here at the command layer.
    if let Some(conf) = result.needs_confirmation.as_mut() {
        if conf.estimated_rows.is_none() {
            conf.estimated_rows = conn.schema_cache.load().table_estimated_rows(&conf.table);
        }
    }
    tracing::info!(
        query_id = %query_id,
        statements = result.statements.len(),
        tx_status = ?result.tx_status,
        errored = result.error.is_some(),
        elapsed_ms = started.elapsed().as_millis() as u64,
        "run_query done"
    );

    // DDL run from within Ariadne makes our own cache stale → silent refresh.
    if touches_schema(&sql) {
        spawn_cache_refresh(app, conn);
    }
    Ok(result)
}

#[tauri::command]
pub async fn fetch_page(
    connection_id: String,
    query_id: String,
    state: State<'_, AppState>,
) -> Result<Page, AriadneError> {
    let conn = state.connection(&connection_id)?;
    exec::fetch_page(&conn.exec, &query_id).await
}

#[tauri::command]
pub async fn cancel_query(
    connection_id: String,
    query_id: String,
    state: State<'_, AppState>,
) -> Result<(), AriadneError> {
    let conn = state.connection(&connection_id)?;
    exec::cancel_query(&conn.exec, &conn.pool, &query_id).await
}

/// Kills the backend of a stuck query. If cancel has no effect within a few seconds,
/// the frontend's "Force kill" button lands here; the pid is resolved server-side
/// from the query_id.
#[tauri::command]
pub async fn force_kill_query(
    connection_id: String,
    query_id: String,
    state: State<'_, AppState>,
) -> Result<bool, AriadneError> {
    let conn = state.connection(&connection_id)?;
    exec::force_kill_query(&conn.exec, &conn.pool, &query_id).await
}

#[tauri::command]
pub async fn close_result(
    connection_id: String,
    tab_id: String,
    state: State<'_, AppState>,
) -> Result<(), AriadneError> {
    let conn = state.connection(&connection_id)?;
    exec::close_result(&conn.exec, &tab_id).await
}
