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

use tauri::Manager;

use state::AppState;

/// Uygulamayı kurar ve çalıştırır. `main.rs`'in tek işi budur.
pub fn run() {
    tauri::Builder::default()
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::profile::list_profiles,
            commands::profile::save_profile,
            commands::profile::delete_profile,
            commands::profile::test_connection,
            commands::connect::connect,
            commands::connect::disconnect,
            commands::schema::get_schema_snapshot,
            commands::schema::refresh_schema,
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
