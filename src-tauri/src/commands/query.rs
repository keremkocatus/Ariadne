//! Query komutları (design 02 §3). M1: connection_id üzerinden çalışır,
//! DDL sonrası cache'i otomatik tazeler. Cursor/pagination/tx M3'te.

use tauri::{AppHandle, State};

use crate::db::{self, RunResult};
use crate::error::AriadneError;
use crate::state::AppState;

use super::schema::spawn_cache_refresh;

#[tauri::command]
pub async fn run_query(
    connection_id: String,
    sql: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RunResult, AriadneError> {
    let conn = state.connection(&connection_id)?;
    let result = db::run_query(&sql, &conn.pool).await?;

    // Ariadne içinden çalıştırılan DDL kendi cache'imizi bayatlatır → sessiz refresh.
    if db::touches_schema(&sql) {
        spawn_cache_refresh(app, conn);
    }

    Ok(result)
}
