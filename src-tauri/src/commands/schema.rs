//! Şema komutları (design 02 §3, 03).

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

/// Tree'yi besleyen hafif snapshot (design 03 §3).
#[tauri::command]
pub async fn get_schema_snapshot(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<SchemaSnapshot, AriadneError> {
    let conn = state.connection(&connection_id)?;
    Ok(conn.schema_cache.load().to_snapshot())
}

/// Manuel refresh: yeni snapshot kurar; başlangıç/bitiş event ile bildirilir.
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

/// Arka planda cache fetch + atomik swap + event. connect ve refresh_schema ortak
/// kullanır. Hata olursa eski snapshot korunur (design 06 §4) — sessiz log.
///
/// Debounce (design 03 §5 / 11 §H7): zaten çalışan bir refresh varsa yenisi
/// başlatılmaz (üst üste DDL'ler tek fetch'e birleşir).
pub fn spawn_cache_refresh(app: AppHandle, conn: Arc<ActiveConnection>) {
    use std::sync::atomic::Ordering;
    // swap(true): önceki değer true ise başka refresh çalışıyor → atla.
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
                // Eski snapshot immutable olarak kalır; kullanıcı yine çalışabilir.
                tracing::warn!(connection_id = %connection_id, error = %e.message, "schema refresh failed");
            }
        }
        conn.refreshing.store(false, Ordering::Release);
        let _ = app.emit("schema:refreshed", ConnPayload { connection_id });
    });
}

/// Boş cache ile ActiveConnection kur (connect anında; fetch arka planda dolar).
pub fn empty_cache(server_version: String) -> SchemaCache {
    SchemaCache::empty(server_version)
}
