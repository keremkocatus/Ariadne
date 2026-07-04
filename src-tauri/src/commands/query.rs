//! Query komutları (design 02 §3, 05). M3: cursor'lu execution, pagination,
//! cancel, tab=session transaction, destructive guard.
//!
//! API notu (design'dan pratik sapma): run_query request'i client-üretimli
//! `query_id` taşır (çalışırken cancel için); fetch_page/cancel/close ayrıca
//! `connection_id` alır. Frontend ikisini de bilir.

use tauri::{AppHandle, State};

use crate::db::exec::{self, RunArgs, PAGE_SIZE};
use crate::db::touches_schema;
use crate::db::types::{Page, RunResult};
use crate::error::AriadneError;
use crate::state::AppState;

use super::schema::spawn_cache_refresh;

// Tauri IPC sınırı: her argüman JS invoke payload'ından ayrı deserialize edilir;
// struct'a paketlemek api.ts sözleşmesini bozar (design 02 §1). Bilinçli sınır.
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
    // SQL metni yalnız debug seviyesinde (design 06 §2); info'da süre/sonuç.
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

    // Destructive guard satır tahminini cache'ten doldur (design 11 §H6). db katmanı
    // cache'ten habersizdir (design 01 §4); tahmin bu komut katmanında eklenir.
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

    // Ariadne içinden çalıştırılan DDL kendi cache'imizi bayatlatır → sessiz refresh.
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

#[tauri::command]
pub async fn close_result(
    connection_id: String,
    tab_id: String,
    state: State<'_, AppState>,
) -> Result<(), AriadneError> {
    let conn = state.connection(&connection_id)?;
    exec::close_result(&conn.exec, &tab_id).await
}
