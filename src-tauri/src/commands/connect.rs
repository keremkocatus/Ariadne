//! Connection commands.

use std::sync::Arc;

use arc_swap::ArcSwap;
use serde::Serialize;
use sqlx::Row;
use tauri::{AppHandle, State};

use crate::db::build_pool;
use crate::error::{AriadneError, ErrorKind};
use crate::profiles::{self};
use crate::state::{ActiveConnection, AppState, ConnectionInfo};

use super::schema::{empty_cache, spawn_cache_refresh};

/// Connect to a profile: build the pool, return ConnectionInfo; the cache fetch
/// starts **in the background**.
///
/// `database_override`: if given, connect to this database instead of the profile's.
/// Password/SSL/timeout come from the profile; only the target database changes.
#[tauri::command]
pub async fn connect(
    profile_id: String,
    database_override: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ConnectionInfo, AriadneError> {
    let profile = state
        .profiles
        .get(&profile_id)
        .ok_or_else(|| AriadneError::new(ErrorKind::ConnectionFailed, "Profile not found"))?;

    let password = profiles::get_password(&profile_id)?;
    let pool = build_pool(&profile, password.as_deref(), database_override.as_deref()).await?;

    let server_version: String = sqlx::query("SHOW server_version")
        .fetch_one(&pool)
        .await?
        .try_get(0)?;

    let database = database_override.unwrap_or_else(|| profile.database.clone());
    let connection_id = uuid::Uuid::new_v4().to_string();
    let info = ConnectionInfo {
        connection_id: connection_id.clone(),
        profile_id: profile_id.clone(),
        server_version: server_version.clone(),
        database,
        user: profile.user.clone(),
        color: profile.color.clone(),
    };

    let conn = Arc::new(ActiveConnection {
        id: connection_id.clone(),
        profile_id,
        pool,
        schema_cache: ArcSwap::from_pointee(empty_cache(server_version)),
        info: info.clone(),
        exec: Default::default(),
        refreshing: std::sync::atomic::AtomicBool::new(false),
    });

    state
        .connections
        .write()
        .unwrap()
        .insert(connection_id, conn.clone());

    // Password/host are never logged; only identifying fields.
    tracing::info!(
        connection_id = %info.connection_id,
        database = %info.database,
        server = %info.server_version,
        "connected"
    );

    // Fill the cache in the background.
    spawn_cache_refresh(app, conn);

    Ok(info)
}

/// Disconnect: running queries are cancelled, open cursors/transactions are closed,
/// then the pool is closed and removed from the map.
#[tauri::command]
pub async fn disconnect(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<(), AriadneError> {
    let conn = state.connections.write().unwrap().remove(&connection_id);
    if let Some(conn) = conn {
        // Clean up cursors/transactions/running queries before closing the pool.
        conn.exec.shutdown(&conn.pool).await;
        conn.pool.close().await;
    }
    Ok(())
}

/// Connectable databases on the server (for the "Databases ▸" switcher).
#[derive(Serialize)]
pub struct DatabaseInfo {
    pub name: String,
    /// Whether this is the database the connection is currently on (marked in the menu).
    pub is_current: bool,
}

/// Lists the other databases on the same server for switching. Template and
/// non-connectable databases are excluded (`pg_database`). On-demand — not cached.
#[tauri::command]
pub async fn list_databases(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<DatabaseInfo>, AriadneError> {
    let conn = state.connection(&connection_id)?;
    let current = conn.info.database.clone();
    let rows = sqlx::query(
        "SELECT datname FROM pg_database \
         WHERE datallowconn AND NOT datistemplate \
         ORDER BY datname",
    )
    .fetch_all(&conn.pool)
    .await?;
    rows.into_iter()
        .map(|r| {
            let name: String = r.try_get("datname")?;
            Ok(DatabaseInfo {
                is_current: name == current,
                name,
            })
        })
        .collect()
}
