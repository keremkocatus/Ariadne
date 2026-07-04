//! Ariadne kütüphane kökü (design 11 §R1).
//!
//! `main.rs` yalnızca `run()`'ı çağırır; tüm modüller ve Tauri builder burada
//! yaşar. Böylece `tests/` klasöründeki integration testler crate'i
//! `use ariadne::...` ile import edebilir (design 08 §2). Faz 0'da yalnızca unit
//! test var; bu ayrım gerçek-DB integration testlerini Faz 1'de mümkün kılar.

mod cache;
mod commands;
mod complete;
mod db;
mod error;
mod logging;
mod profiles;
mod state;

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use state::{ActiveConnection, AppState};

/// Idle cursor kontrol periyodu ve eşiği (design 05 §2 / 11 §H7).
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const CURSOR_IDLE_LIMIT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Serialize)]
struct FrozenPayload {
    connection_id: String,
    tab_id: String,
}

/// Uygulamayı kurar ve çalıştırır. `main.rs`'in tek işi budur.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Logging: konsol + dönen dosya (design 01 §6). Dosya yolu alınamazsa
            // yalnız konsola düşer.
            if let Ok(log_dir) = app.path().app_log_dir() {
                logging::init(log_dir);
            }
            // Profiller {app_config_dir}/profiles.json'da tutulur (design 06 §1).
            let config_dir = app.path().app_config_dir()?;
            tracing::info!("Ariadne started");
            app.manage(AppState::new(config_dir));
            spawn_idle_cursor_sweeper(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::profile::list_profiles,
            commands::profile::save_profile,
            commands::profile::delete_profile,
            commands::profile::test_connection,
            commands::connect::connect,
            commands::connect::disconnect,
            commands::connect::list_databases,
            commands::schema::get_schema_snapshot,
            commands::schema::refresh_schema,
            commands::details::get_relation_details,
            commands::details::get_function_source,
            commands::roles::list_roles,
            commands::files::read_text_file,
            commands::files::write_text_file,
            commands::query::run_query,
            commands::query::fetch_page,
            commands::query::cancel_query,
            commands::query::close_result,
            commands::complete::get_completions,
            commands::complete::get_object_info,
            commands::complete::get_signature_help,
        ])
        .run(tauri::generate_context!())
        .expect("Ariadne başlatılamadı");
}

/// Periyodik olarak tüm bağlantıların idle iç-tx cursor'larını kapatır (design 11 §H7):
/// uzun açık kalan READ ONLY tx'ler prod'da vacuum'u geciktirmesin. Kapatılan tab
/// için `result:frozen` event'i → grid "sonuç dondu, yeniden çalıştır" bandı gösterir.
fn spawn_idle_cursor_sweeper(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            // RwLock guard'ını await boyunca tutma: bağlantıları klonlayıp bırak.
            let conns: Vec<Arc<ActiveConnection>> = {
                let state = app.state::<AppState>();
                let guard = state.connections.read().unwrap();
                guard.values().cloned().collect()
            };
            for conn in conns {
                for tab_id in conn.exec.sweep_idle_cursors(CURSOR_IDLE_LIMIT).await {
                    tracing::info!(connection_id = %conn.id, tab_id = %tab_id, "idle cursor closed");
                    let _ = app.emit(
                        "result:frozen",
                        FrozenPayload {
                            connection_id: conn.id.clone(),
                            tab_id,
                        },
                    );
                }
            }
        }
    });
}
