//! Profile commands.

use std::time::Instant;

use serde::Serialize;
use sqlx::Row;
use tauri::State;

use crate::db::build_pool;
use crate::error::AriadneError;
use crate::profiles::{ConnectionProfile, ProfileInput};
use crate::state::AppState;

#[tauri::command]
pub async fn list_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionProfile>, AriadneError> {
    Ok(state.profiles.list())
}

/// Saves the profile (create/update); if a password is given it goes to the keyring,
/// never to JSON.
#[tauri::command]
pub async fn save_profile(
    profile: ProfileInput,
    password: Option<String>,
    state: State<'_, AppState>,
) -> Result<ConnectionProfile, AriadneError> {
    state.profiles.save(profile, password)
}

#[tauri::command]
pub async fn delete_profile(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<(), AriadneError> {
    state.profiles.delete(&profile_id)
}

#[derive(Serialize)]
pub struct TestResult {
    pub server_version: String,
    pub latency_ms: u64,
}

/// Tries the connection without persisting the profile (the "Test" button in the
/// connection dialog).
#[tauri::command]
pub async fn test_connection(
    profile: ProfileInput,
    password: Option<String>,
    _state: State<'_, AppState>,
) -> Result<TestResult, AriadneError> {
    let temp = profile.into_profile_temp();
    let started = Instant::now();
    let pool = build_pool(&temp, password.as_deref(), None).await?;
    let server_version: String = sqlx::query("SHOW server_version")
        .fetch_one(&pool)
        .await?
        .try_get(0)?;
    let latency_ms = started.elapsed().as_millis() as u64;
    pool.close().await;
    Ok(TestResult {
        server_version,
        latency_ms,
    })
}
