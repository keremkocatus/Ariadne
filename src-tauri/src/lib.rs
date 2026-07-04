//! Library root.
//!
//! `main.rs` only calls `run()`; every module and the Tauri builder live here so
//! that integration tests can import the crate as `ariadne_lib::…`.

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

/// How often idle cursors are swept, and how long a cursor may stay idle first.
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const CURSOR_IDLE_LIMIT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Serialize)]
struct FrozenPayload {
    connection_id: String,
    tab_id: String,
}

/// Builds and runs the application. The only thing `main.rs` calls.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Logging: console + rolling file. Falls back to console only if the
            // log directory can't be resolved.
            if let Ok(log_dir) = app.path().app_log_dir() {
                logging::init(log_dir);
            }
            // Profiles are stored in {app_config_dir}/profiles.json.
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
            commands::query::force_kill_query,
            commands::query::close_result,
            commands::activity::list_activity,
            commands::activity::signal_backend,
            commands::activity::db_stats,
            commands::edit::get_primary_key,
            commands::edit::update_cell,
            commands::complete::get_completions,
            commands::complete::get_object_info,
            commands::complete::get_signature_help,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Ariadne");
}

/// Periodically closes idle internal-transaction cursors across all connections so
/// that long-lived READ ONLY transactions don't hold back vacuum in production. For
/// each closed tab it emits `result:frozen`, which makes the grid show a
/// "result expired — re-run to continue paging" banner.
fn spawn_idle_cursor_sweeper(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            // Don't hold the RwLock guard across await points: clone the connections out.
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
