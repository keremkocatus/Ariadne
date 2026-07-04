//! Schema commands.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::cache::{catalog, SchemaCache, SchemaSnapshot};
use crate::error::AriadneError;
use crate::state::{ActiveConnection, AppState};

#[derive(Clone, Serialize)]
struct ConnPayload {
    connection_id: String,
}

/// The lightweight snapshot that feeds the tree.
#[tauri::command]
pub async fn get_schema_snapshot(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<SchemaSnapshot, AriadneError> {
    let conn = state.connection(&connection_id)?;
    Ok(conn.schema_cache.load().to_snapshot())
}

/// Manual refresh: builds a new snapshot; start/finish are announced via events.
#[tauri::command]
pub async fn refresh_schema(
    connection_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AriadneError> {
    let conn = state.connection(&connection_id)?;
    spawn_cache_refresh(app, conn);
    Ok(())
}

/// Background cache fetch + atomic swap + event. Shared by connect and
/// refresh_schema. On error the old snapshot is kept — logged quietly.
///
/// Debounce: if a refresh is already running, a new one isn't started (bursts of
/// DDL coalesce into a single fetch).
pub fn spawn_cache_refresh(app: AppHandle, conn: Arc<ActiveConnection>) {
    use std::sync::atomic::Ordering;
    // swap(true): if the previous value was true, another refresh is running → skip.
    if conn.refreshing.swap(true, Ordering::AcqRel) {
        return;
    }
    let connection_id = conn.id.clone();
    let _ = app.emit(
        "schema:refresh_started",
        ConnPayload {
            connection_id: connection_id.clone(),
        },
    );
    tauri::async_runtime::spawn(async move {
        // RAII: the flag is reset even if the task unwinds on panic (otherwise all
        // future refreshes for this connection would be permanently blocked).
        let _guard = RefreshGuard(conn.clone());
        let started = std::time::Instant::now();
        match catalog::fetch_schema_cache(&conn.pool).await {
            Ok(new_cache) => {
                let (tables, functions) = (new_cache.tables.len(), new_cache.functions.len());
                conn.schema_cache.store(Arc::new(new_cache));
                tracing::info!(
                    connection_id = %connection_id,
                    tables,
                    functions,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "schema cache refreshed"
                );
            }
            Err(e) => {
                // The old snapshot stays immutable; the user can still work.
                tracing::warn!(connection_id = %connection_id, error = %e.message, "schema refresh failed");
            }
        }
        let _ = app.emit("schema:refreshed", ConnPayload { connection_id });
    });
}

/// Resets the `refreshing` flag on drop (normal finish OR panic unwind).
struct RefreshGuard(Arc<ActiveConnection>);
impl Drop for RefreshGuard {
    fn drop(&mut self) {
        self.0
            .refreshing
            .store(false, std::sync::atomic::Ordering::Release);
    }
}

/// Builds an ActiveConnection with an empty cache (at connect time; the fetch fills
/// it in the background).
pub fn empty_cache(server_version: String) -> SchemaCache {
    SchemaCache::empty(server_version)
}
