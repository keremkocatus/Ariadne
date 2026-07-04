//! Bağlantı komutları (design 02 §3, 06).

use std::sync::Arc;

use arc_swap::ArcSwap;
use sqlx::Row;
use tauri::{AppHandle, State};

use crate::db::build_pool;
use crate::error::{AriadneError, ErrorKind};
use crate::profiles::{self};
use crate::state::{ActiveConnection, AppState, ConnectionInfo};

use super::schema::{empty_cache, spawn_cache_refresh};

/// Profile bağlan: pool kur, ConnectionInfo dön; cache fetch **arka planda** başlar.
#[tauri::command]
pub async fn connect(
    profile_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ConnectionInfo, AriadneError> {
    let profile = state
        .profiles
        .get(&profile_id)
        .ok_or_else(|| AriadneError::new(ErrorKind::ConnectionFailed, "Profile not found"))?;

    let password = profiles::get_password(&profile_id)?;
    let pool = build_pool(&profile, password.as_deref()).await?;

    let server_version: String = sqlx::query("SHOW server_version")
        .fetch_one(&pool)
        .await?
        .try_get(0)?;

    let connection_id = uuid::Uuid::new_v4().to_string();
    let info = ConnectionInfo {
        connection_id: connection_id.clone(),
        profile_id: profile_id.clone(),
        server_version: server_version.clone(),
        database: profile.database.clone(),
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

    // Şifre/host loglanmaz (design 06 §2); yalnız kimliklendirici alanlar.
    tracing::info!(
        connection_id = %info.connection_id,
        database = %info.database,
        server = %info.server_version,
        "connected"
    );

    // Cache'i arka planda doldur.
    spawn_cache_refresh(app, conn);

    Ok(info)
}

/// Bağlantıyı kapat: çalışan sorgular iptal edilir, açık cursor/tx'ler kapatılır,
/// sonra pool kapatılır ve map'ten silinir (design 11 §H3).
#[tauri::command]
pub async fn disconnect(
    connection_id: String,
    state: State<'_, AppState>,
) -> Result<(), AriadneError> {
    let conn = state.connections.write().unwrap().remove(&connection_id);
    if let Some(conn) = conn {
        // Pool'u kapatmadan önce cursor/tx/çalışan sorguları temizle.
        conn.exec.shutdown(&conn.pool).await;
        conn.pool.close().await;
    }
    Ok(())
}
