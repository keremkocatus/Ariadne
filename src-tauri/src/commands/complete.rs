//! Completion komutları (design 02 §3, 04). Hepsi cache'ten hesaplanır — DB
//! round-trip YOK; hedef < 10ms (design 01 §7).

use tauri::State;

use crate::complete::{self, CompletionResult, ObjectInfo, SignatureHelp};
use crate::error::AriadneError;
use crate::state::AppState;

#[tauri::command]
pub async fn get_completions(
    connection_id: String,
    sql: String,
    cursor_offset: usize,
    state: State<'_, AppState>,
) -> Result<CompletionResult, AriadneError> {
    let conn = state.connection(&connection_id)?;
    let cache = conn.schema_cache.load();
    Ok(complete::complete(&cache, &sql, cursor_offset))
}

#[tauri::command]
pub async fn get_object_info(
    connection_id: String,
    sql: String,
    cursor_offset: usize,
    state: State<'_, AppState>,
) -> Result<Option<ObjectInfo>, AriadneError> {
    let conn = state.connection(&connection_id)?;
    let cache = conn.schema_cache.load();
    Ok(complete::object_info(&cache, &sql, cursor_offset))
}

#[tauri::command]
pub async fn get_signature_help(
    connection_id: String,
    sql: String,
    cursor_offset: usize,
    state: State<'_, AppState>,
) -> Result<Option<SignatureHelp>, AriadneError> {
    let conn = state.connection(&connection_id)?;
    let cache = conn.schema_cache.load();
    Ok(complete::signature_help(&cache, &sql, cursor_offset))
}
