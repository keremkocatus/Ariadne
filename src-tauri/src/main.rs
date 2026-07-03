// Release'te Windows'ta konsol penceresi açılmasın.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod commands;
mod complete;
mod db;
mod error;
mod profiles;
mod state;

use tauri::Manager;

use state::AppState;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Profiller {app_config_dir}/profiles.json'da tutulur (design 06 §1).
            let config_dir = app.path().app_config_dir()?;
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
            commands::complete::get_completions,
            commands::complete::get_object_info,
            commands::complete::get_signature_help,
        ])
        .run(tauri::generate_context!())
        .expect("Ariadne başlatılamadı");
}
