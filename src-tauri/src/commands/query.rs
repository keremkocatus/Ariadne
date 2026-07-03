//! Query komutları (design 02 §3). M0: sadece `run_query`.

use tauri::State;

use crate::db::{self, RunResult};
use crate::error::AriadneError;
use crate::state::AppState;

/// M0: tek hardcoded bağlantı → cursor'suz çalıştır → tek sayfa dön.
/// connection_id / tab_id / pagination M1–M3'te eklenecek.
#[tauri::command]
pub async fn run_query(
    sql: String,
    state: State<'_, AppState>,
) -> Result<RunResult, AriadneError> {
    let pool = state.pool().await?;
    db::run_query(&sql, pool).await
}
